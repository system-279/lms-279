#!/usr/bin/env npx tsx
/**
 * tenant 配下 lesson_sessions の「期限切れ active セッション」滞留調査スクリプト（read-only）
 *
 * 目的:
 *   テスト任意化 Stage 5(ケースD厳格化) の `QUIZ_REQUIRE_ACTIVE_SESSION` を
 *   false → true へ切替える前に、期限切れ（deadlineAt < now）だが status がまだ
 *   `active` のまま滞留しているセッション数を定量化する（セカンドオピニオン反映）。
 *
 *   `forceExitSession` は `sessionVideoCompleted=false` かつ reason が time_limit/
 *   pause_timeout 以外（または永続完了未確認）の場合、学習データを全リセットする
 *   （ADR-027 ケースE）。true への切替後は POST /quizzes/:quizId/attempts が
 *   このような滞留セッションに到達する経路が増えるため、切替前に規模を把握する。
 *
 *   sessionVideoCompleted=true（リセットされない、cleanup のみ）と false（全リセット
 *   対象）を分けて件数表示する。
 *
 * 安全機構:
 *   - read-only（書き込み一切なし）
 *   - tenant_id は必須入力
 *   - lessonId 別件数のみ表示し、userId / email は表示しない（PII 制限）
 *
 * 使用方法:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *     npx tsx scripts/audit-active-session-staleness.ts \
 *     --tenant-id=8vexhzpc \
 *     --top-lessons=20
 *
 * 前提:
 *   firestore.indexes.json に (status ASC, deadlineAt ASC) の composite index を追加済み。
 *   .github/workflows/deploy.yml の deploy-firestore-indexes ジョブが main への push 時に
 *   `firebase deploy --only firestore:indexes` を自動実行するため、本 PR の merge 後に手動操作は
 *   不要（second opinion レビュー指摘反映: 当初「CI/CD には含まれない」と誤記していたが、
 *   このリポジトリでは既に自動デプロイされる既存ジョブがある）。
 *
 * 環境変数:
 *   GOOGLE_APPLICATION_CREDENTIALS  サービスアカウント JSON のパス（WIF 環境では external_account JSON）
 *   GOOGLE_CLOUD_PROJECT            プロジェクト ID
 */

import {
  initializeApp,
  cert,
  applicationDefault,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore, type Firestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { resolve } from "path";

// ============================================================
// 純粋関数（smoke test 対象）
// ============================================================

/** sessionVideoCompleted の tri-state（force-exit 時のリセット有無の判定材料）。 */
export type SessionVideoCompletedFlag = boolean | null;

export interface RawStaleSession {
  readonly lessonId: string | null;
  readonly sessionVideoCompleted: SessionVideoCompletedFlag;
  readonly deadlineAt: string;
}

export interface StalenessSummary {
  readonly totalStale: number;
  /** sessionVideoCompleted=true（cleanup のみ、全リセットされない） */
  readonly videoCompletedCount: number;
  /** sessionVideoCompleted=false（forceExitSession で全リセット対象になりうる） */
  readonly videoIncompleteCount: number;
  /** sessionVideoCompleted=null（フィールド欠落等、判定不能） */
  readonly videoUnknownCount: number;
  /** videoIncomplete のうち lessonId 別件数（降順、top N でカット） */
  readonly lessonCounts: ReadonlyArray<{ readonly lessonId: string; readonly count: number }>;
  readonly lessonTruncated: number;
  readonly lessonUniqueCount: number;
}

/** 集計（純粋関数）。 */
export function aggregateStaleSessions(
  sessions: ReadonlyArray<RawStaleSession>,
  topLessons: number
): StalenessSummary {
  let videoCompletedCount = 0;
  let videoIncompleteCount = 0;
  let videoUnknownCount = 0;
  const lessonMap = new Map<string, number>();

  for (const s of sessions) {
    if (s.sessionVideoCompleted === true) {
      videoCompletedCount++;
    } else if (s.sessionVideoCompleted === false) {
      videoIncompleteCount++;
      const lessonId = s.lessonId ?? "(missing-lessonId)";
      lessonMap.set(lessonId, (lessonMap.get(lessonId) ?? 0) + 1);
    } else {
      videoUnknownCount++;
    }
  }

  const allLessons = Array.from(lessonMap.entries())
    .map(([lessonId, count]) => ({ lessonId, count }))
    .sort((a, b) => b.count - a.count);

  const lessonCounts = allLessons.slice(0, topLessons);
  const lessonTruncated = Math.max(0, allLessons.length - topLessons);

  return {
    totalStale: sessions.length,
    videoCompletedCount,
    videoIncompleteCount,
    videoUnknownCount,
    lessonCounts,
    lessonTruncated,
    lessonUniqueCount: allLessons.length,
  };
}

// ============================================================
// CLI / メイン
// ============================================================

const ARG_PREFIXES = ["--tenant-id=", "--top-lessons="] as const;

const isMainEntry = import.meta.url === `file://${process.argv[1]}`;

if (isMainEntry) {
  main().catch((err) => {
    console.error(`[FATAL] 予期しないエラー: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (const a of args) {
    if (!ARG_PREFIXES.some((p) => a.startsWith(p))) {
      console.error(`[FATAL] 未知の引数: "${a}" (許容: ${ARG_PREFIXES.join(", ")})`);
      process.exit(1);
    }
  }

  const tenantId = args
    .find((a) => a.startsWith("--tenant-id="))
    ?.replace("--tenant-id=", "")
    .trim();
  if (!tenantId) {
    console.error("[FATAL] --tenant-id=<id> は必須");
    process.exit(1);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    console.error(`[FATAL] --tenant-id の形式が不正（英数/_/-のみ許可）: "${tenantId}"`);
    process.exit(1);
  }

  const topLessonsRaw = args
    .find((a) => a.startsWith("--top-lessons="))
    ?.replace("--top-lessons=", "")
    .trim();
  const topLessons = topLessonsRaw ? Number(topLessonsRaw) : 20;
  if (!Number.isInteger(topLessons) || topLessons <= 0 || topLessons > 200) {
    console.error(`[FATAL] --top-lessons は 1〜200 の整数: 受け取った値="${topLessonsRaw}"`);
    process.exit(1);
  }

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    if (credPath) {
      const jsonPath = resolve(process.cwd(), credPath);
      const credJson = JSON.parse(readFileSync(jsonPath, "utf8")) as { type?: string };
      if (credJson.type === "service_account") {
        initializeApp({ credential: cert(credJson as ServiceAccount) });
        console.log(`認証: サービスアカウントJSON (${jsonPath})`);
      } else {
        initializeApp({ credential: applicationDefault() });
        console.log(`認証: Application Default Credentials (cred file type=${credJson.type ?? "unknown"})`);
      }
    } else {
      initializeApp({ credential: applicationDefault() });
      console.log("認証: Application Default Credentials");
    }
  } catch (err) {
    console.error(`[FATAL] Firebase 初期化失敗: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const db = getFirestore();

  console.log("=== tenant 配下 lesson_sessions 期限切れ active セッション滞留調査 ===");
  console.log(`tenant: ${tenantId}`);
  console.log(`lesson 別表示上位件数: ${topLessons}`);
  console.log();

  const tenantRef = db.collection("tenants").doc(tenantId);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) {
    console.error(`[FATAL] tenant not found: ${tenantId}`);
    process.exit(1);
  }
  const tenantName = tenantDoc.data()?.name;
  console.log(
    `tenant 確認: ${tenantId} (name="${typeof tenantName === "string" ? tenantName : ""}")\n`
  );

  const { sessions, stats } = await fetchStaleActiveSessions(db, tenantId);
  console.log(
    `取得件数: ${stats.fetchedCount}（うち集計対象=期限切れ: ${sessions.length} / deadlineAt 欠落・不正: ${stats.deadlineAtMalformed}）`
  );
  if (stats.hitFetchCap) {
    console.warn(
      `[WARN] Firestore 取得が上限 ${FETCH_LIMIT} 件に達しました。orderBy("deadlineAt", "asc") により最も古い（超過幅が大きい）滞留セッションから ${FETCH_LIMIT} 件を保証しますが、これより新しい期限切れセッションが集計対象外になっている可能性があります。`
    );
  }
  console.log();

  const summary = aggregateStaleSessions(sessions, topLessons);
  printSummary(summary);
}

interface IoSkipStats {
  hitFetchCap: boolean;
  fetchedCount: number;
  deadlineAtMalformed: number;
}

const FETCH_LIMIT = 2000;

async function fetchStaleActiveSessions(
  db: Firestore,
  tenantId: string
): Promise<{ sessions: RawStaleSession[]; stats: IoSkipStats }> {
  // status=active かつ deadlineAt < now を取得。
  // deadlineAt 昇順（最も古い＝超過幅が大きい滞留から） FETCH_LIMIT 件を保証する。
  // 必要な composite index は firestore.indexes.json の (status ASC, deadlineAt ASC)。
  const now = Timestamp.now();
  const snap = await db
    .collection(`tenants/${tenantId}/lesson_sessions`)
    .where("status", "==", "active")
    .where("deadlineAt", "<", now.toDate().toISOString())
    .orderBy("deadlineAt", "asc")
    .limit(FETCH_LIMIT)
    .get();

  const stats: IoSkipStats = {
    hitFetchCap: snap.size === FETCH_LIMIT,
    fetchedCount: snap.size,
    deadlineAtMalformed: 0,
  };

  const sessions: RawStaleSession[] = [];
  for (const d of snap.docs) {
    const data = d.data() ?? {};

    const deadlineAtRaw = data.deadlineAt;
    let deadlineAtIso: string;
    if (typeof deadlineAtRaw === "string") {
      const parsed = new Date(deadlineAtRaw);
      if (Number.isNaN(parsed.getTime())) {
        stats.deadlineAtMalformed++;
        console.warn(`[WARN] doc ${d.id}: deadlineAt 文字列がパース不可 ("${deadlineAtRaw}")。集計から除外`);
        continue;
      }
      deadlineAtIso = parsed.toISOString();
    } else {
      stats.deadlineAtMalformed++;
      console.warn(`[WARN] doc ${d.id}: deadlineAt が想定外の型 (typeof=${typeof deadlineAtRaw})。集計から除外`);
      continue;
    }

    const lessonId = typeof data.lessonId === "string" ? data.lessonId : null;
    const sessionVideoCompleted: SessionVideoCompletedFlag =
      typeof data.sessionVideoCompleted === "boolean" ? data.sessionVideoCompleted : null;

    sessions.push({ lessonId, sessionVideoCompleted, deadlineAt: deadlineAtIso });
  }
  return { sessions, stats };
}

function printSummary(summary: StalenessSummary): void {
  console.log("=== 期限切れ active セッション 滞留サマリ ===");
  console.log(`  合計: ${summary.totalStale} 件`);
  console.log(
    `  ${summary.videoCompletedCount.toString().padStart(5)}  sessionVideoCompleted=true （cleanup のみ、全リセットされない）`
  );
  console.log(
    `  ${summary.videoIncompleteCount.toString().padStart(5)}  sessionVideoCompleted=false（forceExitSession で全リセット対象になりうる）`
  );
  console.log(
    `  ${summary.videoUnknownCount.toString().padStart(5)}  sessionVideoCompleted=null （不明、判定保留）`
  );
  console.log();

  console.log(`=== 全リセット対象 lesson 別件数 (unique=${summary.lessonUniqueCount}) ===`);
  if (summary.lessonCounts.length === 0) {
    console.log("  (該当なし)");
  } else {
    for (const { lessonId, count } of summary.lessonCounts) {
      console.log(`  ${count.toString().padStart(5)}  ${lessonId}`);
    }
    if (summary.lessonTruncated > 0) {
      console.log(`  ...他 ${summary.lessonTruncated} lesson 省略`);
    }
  }
}
