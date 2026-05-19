#!/usr/bin/env npx tsx
/**
 * 進行中のまま詰まった quiz_attempt の一括救済スクリプト（Issue #422 follow-up）
 *
 * 検出ロジック:
 * 全テナント横断（または指定スコープ内）で以下を満たす quiz_attempt を抽出:
 *   - status == "in_progress"
 *   - 関連する lesson_sessions が以下のいずれか:
 *     - 全 session が終了済み（active が一つもない: force_exited / abandoned / completed）
 *     - active session の deadlineAt < now（期限切れ active）
 *     - 関連 session 不在（一度も session が作成されていない）
 *
 * 更新内容:
 *   - status: "timed_out"
 *   - submittedAt: now
 *   - その他フィールド (answers / score / isPassed / attemptNumber / startedAt / quizId / userId) は触らない
 *
 * 安全機構:
 *   1. dry-run 既定（--execute で実行）
 *   2. スコープ絞り込み（--tenant-id / --user-id / --user-email、排他）
 *   3. 件数アサーション（--max-targets で過剰更新防止、既定 1000）
 *   4. バックアップ JSON 出力（更新前 attempt の snapshot）
 *   5. 条件付き更新 transaction（並行更新で submitted になった attempt は上書きしない）
 *   6. PR #423 で追加した DataSource.transitionQuizAttemptToTimedOut と同等のロジックを admin SDK で実装
 *
 * 使用方法:
 *   # dry-run（全テナント横断、件数 + サンプル表示）
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/cleanup-stuck-quiz-attempts.ts
 *
 *   # 特定テナントのみ
 *   npx tsx scripts/cleanup-stuck-quiz-attempts.ts --tenant-id=xxx
 *
 *   # 特定ユーザー（email、全テナント検索で解決）
 *   npx tsx scripts/cleanup-stuck-quiz-attempts.ts --user-email=foo@bar.com
 *
 *   # 実行
 *   npx tsx scripts/cleanup-stuck-quiz-attempts.ts --execute
 */

import {
  initializeApp,
  cert,
  applicationDefault,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ============================================================
// 純粋関数（smoke test 対象）
// ============================================================

export interface AttemptInfo {
  id: string;
  status: string;
  startedAt: string;
  quizId: string;
  userId: string;
}

export interface SessionInfo {
  id: string;
  status: string;
  deadlineAt: string;
}

/**
 * 救済対象判定（純粋関数）
 * - status != "in_progress" は対象外
 * - 関連 session 不在 → 対象（孤児 attempt）
 * - 全 session が非 active → 対象（session 終了済み）
 * - active session の deadlineAt < now → 対象（期限切れ active）
 */
export function isStuckAttempt(
  attempt: AttemptInfo,
  relatedSessions: SessionInfo[],
  nowMs: number
): boolean {
  if (attempt.status !== "in_progress") return false;
  if (relatedSessions.length === 0) return true;

  const activeSessions = relatedSessions.filter((s) => s.status === "active");
  if (activeSessions.length === 0) return true;

  // active がある場合、すべて期限切れなら対象
  return activeSessions.every((s) => new Date(s.deadlineAt).getTime() < nowMs);
}

// ============================================================
// CLI 引数パース（top-level）
// ============================================================

const KNOWN_FLAGS = [
  "--execute",
  "--tenant-id=",
  "--user-id=",
  "--user-email=",
  "--max-targets=",
  "--no-backup",
];

// テスト import 時の副作用回避: main 実行は明示エントリーポイントで分岐
const isMainEntry = import.meta.url === `file://${process.argv[1]}`;

if (isMainEntry) {
  void runCli();
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter(
    (a) => !KNOWN_FLAGS.some((k) => a === k || a.startsWith(k))
  );
  if (unknownArgs.length > 0) {
    console.error(`[FATAL] 未知のフラグ: ${unknownArgs.join(", ")}`);
    console.error(`  既知のフラグ: ${KNOWN_FLAGS.join(" / ")}`);
    process.exit(1);
  }

  const execute = args.includes("--execute");
  const tenantId = args.find((a) => a.startsWith("--tenant-id="))?.split("=")[1];
  const userId = args.find((a) => a.startsWith("--user-id="))?.split("=")[1];
  const userEmail = args
    .find((a) => a.startsWith("--user-email="))
    ?.split("=")[1]
    ?.trim()
    .toLowerCase();
  const noBackup = args.includes("--no-backup");

  const rawMaxTargets = args
    .find((a) => a.startsWith("--max-targets="))
    ?.split("=")[1];
  const maxTargets = rawMaxTargets !== undefined ? Number(rawMaxTargets) : 1000;
  if (!Number.isFinite(maxTargets) || maxTargets < 1) {
    console.error(
      `[FATAL] --max-targets は 1 以上の数値が必要です: 受け取った値="${rawMaxTargets}"`
    );
    process.exit(1);
  }

  if (userId && userEmail) {
    console.error("[FATAL] --user-id と --user-email は同時指定できません");
    process.exit(1);
  }

  // Firebase 初期化
  // GOOGLE_APPLICATION_CREDENTIALS には以下のいずれかが入り得る:
  //   1. type=service_account の JSON（ローカル開発時のサービスアカウントキー）→ cert() で初期化
  //   2. type=external_account の JSON（GitHub Actions WIF 経由）→ applicationDefault() で初期化
  // type を読まずに cert() を使うと WIF JSON で "project_id" property エラーになる
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    if (credPath) {
      const jsonPath = resolve(process.cwd(), credPath);
      const credJson = JSON.parse(readFileSync(jsonPath, "utf8")) as {
        type?: string;
      };
      if (credJson.type === "service_account") {
        initializeApp({ credential: cert(credJson as ServiceAccount) });
        console.log(`認証: サービスアカウントJSON (${jsonPath})`);
      } else {
        // External Account (WIF) は ADC 経由で初期化する
        initializeApp({ credential: applicationDefault() });
        console.log(
          `認証: Application Default Credentials (cred file type=${credJson.type ?? "unknown"})`
        );
      }
    } else {
      initializeApp({ credential: applicationDefault() });
      console.log("認証: Application Default Credentials");
    }
  } catch (err) {
    console.error(
      `[FATAL] Firebase初期化失敗: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  const db = getFirestore();

  console.log("=== 進行中 quiz_attempt 一括救済 ===");
  console.log(`モード: ${execute ? "EXECUTE（実更新）" : "DRY-RUN（レポートのみ）"}`);
  console.log(`スコープ: tenant=${tenantId ?? "ALL"} userId=${userId ?? "-"} userEmail=${userEmail ?? "-"}`);
  console.log(`最大対象件数: ${maxTargets}`);
  console.log(`バックアップ: ${noBackup ? "無効" : "有効"}\n`);

  // ユーザー解決（--user-email 指定時）
  let scopedUserId = userId;
  let scopedTenantId = tenantId;
  if (userEmail) {
    const resolved = await resolveUserIdFromEmail(db, userEmail, scopedTenantId);
    if (!resolved) {
      console.error(`[FATAL] ユーザーが見つかりません: ${userEmail}`);
      process.exit(1);
    }
    scopedUserId = resolved.userId;
    scopedTenantId = resolved.tenantId;
    console.log(
      `ユーザー解決: ${userEmail} → tenantId=${scopedTenantId} userId=${scopedUserId}\n`
    );
  }

  // 対象テナント一覧
  const tenantsSnap = await db.collection("tenants").get();
  if (tenantsSnap.empty) {
    console.error("[FATAL] tenants コレクションが空です。権限/プロジェクトID 確認してください。");
    process.exit(1);
  }
  const tenantIds = scopedTenantId
    ? [scopedTenantId]
    : tenantsSnap.docs.map((d) => d.id);

  // 抽出
  const stuckList = await findStuckAttempts(db, tenantIds, scopedUserId);
  console.log(`\n=== 抽出結果 ===`);
  console.log(`救済対象: ${stuckList.length} 件`);

  if (stuckList.length === 0) {
    console.log("救済対象なし");
    return;
  }

  // バックアップ
  if (!noBackup) {
    const backupPath = `cleanup-stuck-backup-${Date.now()}.json`;
    writeFileSync(backupPath, JSON.stringify(stuckList, null, 2));
    console.log(`バックアップ: ${backupPath}`);
  }

  // 件数アサーション
  if (stuckList.length > maxTargets) {
    console.error(
      `[FATAL] 救済対象が ${maxTargets} 件を超えています (${stuckList.length} 件)`
    );
    console.error("  --max-targets で上限を上げるか、--tenant-id/--user-id でスコープ絞り込みしてください");
    process.exit(1);
  }

  // サンプル表示
  console.log("\n=== サンプル（最大10件） ===");
  for (const { tenantId: tid, attempt, sessions } of stuckList.slice(0, 10)) {
    console.log(
      `  tenant=${tid} attempt=${attempt.id} user=${attempt.userId} quiz=${attempt.quizId} sessions=${sessions.length}`
    );
  }

  if (!execute) {
    console.log("\nDRY-RUN: --execute で実行");
    return;
  }

  // 実行
  console.log("\n=== 実行 ===");
  let cleaned = 0;
  let skipped = 0;
  let failed = 0;

  for (const { tenantId: tid, attempt } of stuckList) {
    const ref = db.collection(`tenants/${tid}/quiz_attempts`).doc(attempt.id);
    try {
      const result = await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (!doc.exists) return "skipped";
        const current = doc.data()!;
        if (current.status !== "in_progress") return "skipped";
        tx.update(ref, {
          status: "timed_out",
          submittedAt: new Date().toISOString(),
        });
        return "cleaned";
      });
      if (result === "cleaned") cleaned++;
      else skipped++;
    } catch (err) {
      failed++;
      console.error(
        `  失敗: tenant=${tid} attempt=${attempt.id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log(`\n=== 完了 ===`);
  console.log(`  cleaned: ${cleaned}`);
  console.log(`  skipped: ${skipped} (並行更新等で in_progress でなくなっていたもの)`);
  console.log(`  failed:  ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Firestore 連携（dry-run と execute で共通）
// ============================================================

async function resolveUserIdFromEmail(
  db: Firestore,
  email: string,
  tenantId?: string
): Promise<{ userId: string; tenantId: string } | null> {
  const tenants = tenantId
    ? [tenantId]
    : (await db.collection("tenants").get()).docs.map((d) => d.id);
  for (const tid of tenants) {
    const snap = await db
      .collection(`tenants/${tid}/users`)
      .where("email", "==", email)
      .limit(1)
      .get();
    if (!snap.empty) {
      return { userId: snap.docs[0].id, tenantId: tid };
    }
  }
  return null;
}

interface StuckEntry {
  tenantId: string;
  attempt: AttemptInfo;
  sessions: SessionInfo[];
}

async function findStuckAttempts(
  db: Firestore,
  tenantIds: string[],
  scopedUserId?: string
): Promise<StuckEntry[]> {
  const result: StuckEntry[] = [];
  const nowMs = Date.now();

  for (const tid of tenantIds) {
    let attemptsQuery = db
      .collection(`tenants/${tid}/quiz_attempts`)
      .where("status", "==", "in_progress");
    if (scopedUserId) {
      attemptsQuery = attemptsQuery.where("userId", "==", scopedUserId);
    }
    const attemptsSnap = await attemptsQuery.get();
    if (attemptsSnap.empty) continue;

    for (const doc of attemptsSnap.docs) {
      const data = doc.data();
      const attempt: AttemptInfo = {
        id: doc.id,
        status: data.status,
        startedAt: data.startedAt,
        quizId: data.quizId,
        userId: data.userId,
      };

      // quiz から lessonId を解決
      const quizDoc = await db
        .collection(`tenants/${tid}/quizzes`)
        .doc(attempt.quizId)
        .get();

      // quiz 削除済み → 関連 session なし扱いで救済対象
      if (!quizDoc.exists) {
        if (isStuckAttempt(attempt, [], nowMs)) {
          result.push({ tenantId: tid, attempt, sessions: [] });
        }
        continue;
      }

      const lessonId = quizDoc.data()!.lessonId as string;

      // 関連 sessions 取得
      const sessionsSnap = await db
        .collection(`tenants/${tid}/lesson_sessions`)
        .where("userId", "==", attempt.userId)
        .where("lessonId", "==", lessonId)
        .get();

      const sessions: SessionInfo[] = sessionsSnap.docs.map((d) => {
        const sd = d.data();
        return {
          id: d.id,
          status: sd.status,
          deadlineAt: sd.deadlineAt,
        };
      });

      if (isStuckAttempt(attempt, sessions, nowMs)) {
        result.push({ tenantId: tid, attempt, sessions });
      }
    }
  }

  return result;
}
