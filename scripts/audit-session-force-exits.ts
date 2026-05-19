#!/usr/bin/env npx tsx
/**
 * tenant 配下 lesson_sessions の force_exited 強制退室サマリ調査スクリプト（read-only）
 *
 * 目的:
 *   ADR-027 改訂履歴（2026-05-20）の Phase A 効果測定。
 *   3 時間延長（PR #407、2026-05-16 デプロイ）後にケース E（動画再生中の
 *   `time_limit` で `sessionVideoCompleted=false`、全リセット）が
 *   どの程度発生しているかを観察する。
 *
 *   reason 別件数と、time_limit については sessionVideoCompleted フラグ別の
 *   内訳（true=ケース B、false=ケース E）を出力する。
 *   lessonId 別の上位件数も表示し、長尺レッスンの特定に使う。
 *
 * 安全機構:
 *   - read-only（書き込み一切なし）
 *   - tenant_id は必須入力
 *   - userId / lessonId 別件数のみ表示し、userId / email は表示しない（PII 制限）
 *
 * 使用方法:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *     npx tsx scripts/audit-session-force-exits.ts \
 *     --tenant-id=8vexhzpc \
 *     --since-days=30 \
 *     --top-lessons=20
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

export interface RawSession {
  lessonId: string | null;
  exitReason: string | null;
  sessionVideoCompleted: boolean;
  exitAt: string;
}

export interface AggregatedSummary {
  totalForceExits: number;
  /** reason → 件数（降順）。reason=null は "(missing)" として集計。 */
  reasonCounts: Array<{ reason: string; count: number }>;
  /** time_limit のうち sessionVideoCompleted=false（ケース E）= 動画再生中 time_limit で全リセット */
  timeLimitVideoIncomplete: number;
  /** time_limit のうち sessionVideoCompleted=true（ケース B）= 動画完了後 time_limit、reset skip */
  timeLimitVideoCompleted: number;
  /** ケース E に該当する lessonId → 件数（降順、top N でカット） */
  caseELessonCounts: Array<{ lessonId: string; count: number }>;
  /** top N でカットされた残り lesson 件数 */
  caseELessonTruncated: number;
  /** ケース E にマッチした unique lesson 数（top で切られても全体数として把握） */
  caseELessonUniqueCount: number;
}

/**
 * 集計（純粋関数）。
 *
 * @param sessions 取得済み force_exited セッション
 * @param topLessons ケース E の lesson 別上位件数。1 以上。
 */
export function aggregateSessions(
  sessions: RawSession[],
  topLessons: number
): AggregatedSummary {
  const reasonMap = new Map<string, number>();
  let timeLimitVideoIncomplete = 0;
  let timeLimitVideoCompleted = 0;
  const caseELessonMap = new Map<string, number>();

  for (const s of sessions) {
    const reason = s.exitReason ?? "(missing)";
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);

    if (s.exitReason === "time_limit") {
      if (s.sessionVideoCompleted) {
        timeLimitVideoCompleted++;
      } else {
        timeLimitVideoIncomplete++;
        const lessonId = s.lessonId ?? "(missing-lessonId)";
        caseELessonMap.set(lessonId, (caseELessonMap.get(lessonId) ?? 0) + 1);
      }
    }
  }

  const reasonCounts = Array.from(reasonMap.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const allCaseELessons = Array.from(caseELessonMap.entries())
    .map(([lessonId, count]) => ({ lessonId, count }))
    .sort((a, b) => b.count - a.count);

  const caseELessonCounts = allCaseELessons.slice(0, topLessons);
  const caseELessonTruncated = Math.max(0, allCaseELessons.length - topLessons);

  return {
    totalForceExits: sessions.length,
    reasonCounts,
    timeLimitVideoIncomplete,
    timeLimitVideoCompleted,
    caseELessonCounts,
    caseELessonTruncated,
    caseELessonUniqueCount: allCaseELessons.length,
  };
}

// ============================================================
// CLI / メイン
// ============================================================

const ARG_PREFIXES = [
  "--tenant-id=",
  "--since-days=",
  "--top-lessons=",
] as const;

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
      console.error(
        `[FATAL] 未知の引数: "${a}" (許容: ${ARG_PREFIXES.join(", ")})`
      );
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

  const sinceDaysRaw = args
    .find((a) => a.startsWith("--since-days="))
    ?.replace("--since-days=", "")
    .trim();
  const sinceDays = sinceDaysRaw ? Number(sinceDaysRaw) : 30;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0 || sinceDays > 90) {
    console.error(
      `[FATAL] --since-days は 1〜90 の数値: 受け取った値="${sinceDaysRaw}"`
    );
    process.exit(1);
  }

  const topLessonsRaw = args
    .find((a) => a.startsWith("--top-lessons="))
    ?.replace("--top-lessons=", "")
    .trim();
  const topLessons = topLessonsRaw ? Number(topLessonsRaw) : 20;
  if (!Number.isFinite(topLessons) || topLessons <= 0 || topLessons > 200) {
    console.error(
      `[FATAL] --top-lessons は 1〜200 の数値: 受け取った値="${topLessonsRaw}"`
    );
    process.exit(1);
  }

  // Firebase 初期化（audit-tenant-auth-errors.ts と同じ WIF / SA JSON 兼用ロジック）
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
      `[FATAL] Firebase 初期化失敗: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  const db = getFirestore();

  console.log("=== tenant 配下 lesson_sessions force_exited サマリ調査 ===");
  console.log(`tenant: ${tenantId}`);
  console.log(`参照範囲: 直近 ${sinceDays} 日（exitAt 基準）`);
  console.log(`lesson 別表示上位件数: ${topLessons}`);
  console.log();

  const tenantRef = db.collection("tenants").doc(tenantId);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) {
    console.error(`[FATAL] tenant not found: ${tenantId}`);
    process.exit(1);
  }
  console.log(`tenant 確認: ${tenantId} (name="${tenantDoc.data()?.name ?? ""}")\n`);

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const sessions = await fetchForceExitsSince(db, tenantId, since);
  console.log(`取得件数: ${sessions.length}\n`);

  const summary = aggregateSessions(sessions, topLessons);
  printSummary(summary);
}

// ============================================================
// Firestore 取得（read-only）
// ============================================================

async function fetchForceExitsSince(
  db: Firestore,
  tenantId: string,
  since: Date
): Promise<RawSession[]> {
  // status=force_exited に絞ってから exitAt 範囲で再フィルタ（Firestore composite index 回避）。
  // 件数は数十〜数百件想定（本番 8vexhzpc で 30 日分 force_exited は <100 件オーダー）。
  const snap = await db
    .collection(`tenants/${tenantId}/lesson_sessions`)
    .where("status", "==", "force_exited")
    .limit(2000)
    .get();

  const result: RawSession[] = [];
  for (const d of snap.docs) {
    const data = d.data() ?? {};
    const exitAtRaw = data.exitAt;
    let exitAtIso: string;
    if (exitAtRaw instanceof Timestamp) {
      exitAtIso = exitAtRaw.toDate().toISOString();
    } else if (typeof exitAtRaw === "string") {
      exitAtIso = exitAtRaw;
    } else {
      continue; // exitAt がない force_exited は集計対象外
    }
    const exitAtDate = new Date(exitAtIso);
    if (Number.isNaN(exitAtDate.getTime()) || exitAtDate < since) continue;
    result.push({
      lessonId: (data.lessonId as string | undefined) ?? null,
      exitReason: (data.exitReason as string | undefined) ?? null,
      sessionVideoCompleted: Boolean(data.sessionVideoCompleted),
      exitAt: exitAtIso,
    });
  }
  return result;
}

// ============================================================
// 出力
// ============================================================

function printSummary(summary: AggregatedSummary): void {
  console.log("=== reason 別件数 ===");
  if (summary.reasonCounts.length === 0) {
    console.log("  (該当 force_exited なし)");
  } else {
    for (const { reason, count } of summary.reasonCounts) {
      console.log(`  ${count.toString().padStart(5)}  ${reason}`);
    }
  }
  console.log();

  console.log("=== time_limit 内訳（sessionVideoCompleted 別）===");
  console.log(
    `  ${summary.timeLimitVideoIncomplete
      .toString()
      .padStart(5)}  false（ケース E: 動画再生中 time_limit → 全リセット = 本末転倒の発生）`
  );
  console.log(
    `  ${summary.timeLimitVideoCompleted
      .toString()
      .padStart(5)}  true （ケース B: 動画完了後 time_limit → reset skip = 規律どおり）`
  );
  console.log();

  console.log(
    `=== ケース E lesson 別件数 (unique=${summary.caseELessonUniqueCount}) ===`
  );
  if (summary.caseELessonCounts.length === 0) {
    console.log("  (ケース E の該当なし)");
  } else {
    for (const { lessonId, count } of summary.caseELessonCounts) {
      console.log(`  ${count.toString().padStart(5)}  ${lessonId}`);
    }
    if (summary.caseELessonTruncated > 0) {
      console.log(`  ...他 ${summary.caseELessonTruncated} lesson 省略`);
    }
  }
}
