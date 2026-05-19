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

/**
 * sessionVideoCompleted の tri-state。
 * - `true`: 動画完了済（ケース B 候補）
 * - `false`: 動画未完了（ケース E 候補）
 * - `null`: フィールド欠落 / boolean 以外の型（KPI 不明、E/B どちらにも分類せず別バケット）
 *
 * `Boolean()` で false に潰すと「フィールド欠落」が黙ってケース E に算入されて
 * 「本末転倒の発生数」を誤って膨らませるため、明示的に null と区別する。
 */
export type SessionVideoCompletedFlag = boolean | null;

/** 集計対象（"force_exited" 限定、Timestamp は ISO 文字列に正規化済み）。 */
export interface RawSession {
  readonly lessonId: string | null;
  readonly exitReason: string | null;
  readonly sessionVideoCompleted: SessionVideoCompletedFlag;
  readonly exitAt: string;
}

export interface AggregatedSummary {
  readonly totalForceExits: number;
  /** reason → 件数（降順）。reason=null は "(missing)" として集計。 */
  readonly reasonCounts: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
  /** time_limit のうち sessionVideoCompleted=false（ケース E）= 動画再生中 time_limit で全リセット */
  readonly timeLimitVideoIncomplete: number;
  /** time_limit のうち sessionVideoCompleted=true（ケース B）= 動画完了後 time_limit、reset skip */
  readonly timeLimitVideoCompleted: number;
  /** time_limit のうち sessionVideoCompleted=null（不明）= データ不整合 / 欠落、E/B 分類保留 */
  readonly timeLimitVideoUnknown: number;
  /** ケース E に該当する lessonId → 件数（降順、top N でカット） */
  readonly caseELessonCounts: ReadonlyArray<{ readonly lessonId: string; readonly count: number }>;
  /** top N でカットされた残り lesson 件数 */
  readonly caseELessonTruncated: number;
  /** ケース E にマッチした unique lesson 数（top で切られても全体数として把握） */
  readonly caseELessonUniqueCount: number;
}

/**
 * 集計（純粋関数）。
 *
 * @param sessions 取得済み force_exited セッション
 * @param topLessons ケース E の lesson 別上位件数。1 以上。
 */
export function aggregateSessions(
  sessions: ReadonlyArray<RawSession>,
  topLessons: number
): AggregatedSummary {
  const reasonMap = new Map<string, number>();
  let timeLimitVideoIncomplete = 0;
  let timeLimitVideoCompleted = 0;
  let timeLimitVideoUnknown = 0;
  const caseELessonMap = new Map<string, number>();

  for (const s of sessions) {
    const reason = s.exitReason ?? "(missing)";
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);

    if (s.exitReason === "time_limit") {
      if (s.sessionVideoCompleted === true) {
        timeLimitVideoCompleted++;
      } else if (s.sessionVideoCompleted === false) {
        timeLimitVideoIncomplete++;
        const lessonId = s.lessonId ?? "(missing-lessonId)";
        caseELessonMap.set(lessonId, (caseELessonMap.get(lessonId) ?? 0) + 1);
      } else {
        // null: フィールド欠落 / boolean 以外。E/B どちらにも算入しない。
        timeLimitVideoUnknown++;
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
    timeLimitVideoUnknown,
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
  if (!Number.isInteger(sinceDays) || sinceDays <= 0 || sinceDays > 90) {
    console.error(
      `[FATAL] --since-days は 1〜90 の整数: 受け取った値="${sinceDaysRaw}"`
    );
    process.exit(1);
  }

  const topLessonsRaw = args
    .find((a) => a.startsWith("--top-lessons="))
    ?.replace("--top-lessons=", "")
    .trim();
  const topLessons = topLessonsRaw ? Number(topLessonsRaw) : 20;
  if (!Number.isInteger(topLessons) || topLessons <= 0 || topLessons > 200) {
    console.error(
      `[FATAL] --top-lessons は 1〜200 の整数: 受け取った値="${topLessonsRaw}"`
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
  const tenantName = tenantDoc.data()?.name;
  if (typeof tenantName !== "string" || tenantName === "") {
    console.warn(
      `[WARN] tenant ${tenantId} の name フィールドが空または非 string。tenant ID 自体は exists のため処理続行するが、対象テナントが正しいか再確認してください。`
    );
  }
  console.log(
    `tenant 確認: ${tenantId} (name="${typeof tenantName === "string" ? tenantName : ""}")\n`
  );

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const { sessions, stats } = await fetchForceExitsSince(db, tenantId, since);
  console.log(
    `取得件数: ${stats.fetchedCount}（うち集計対象: ${sessions.length} / 期間外: ${stats.outOfRange} / exitAt 欠落: ${stats.exitAtMissing} / exitAt 形式不正: ${stats.exitAtMalformed}）`
  );
  if (stats.hitFetchCap) {
    console.warn(
      `[WARN] Firestore 取得が上限 ${FETCH_LIMIT} 件に達しました。tenant の累積 force_exited が大きく、古いセッションが欠落している可能性があります。集計値は最大 ${FETCH_LIMIT} 件分のみを反映している点に注意してください。`
    );
  }
  if (
    stats.lessonIdNonString > 0 ||
    stats.exitReasonNonString > 0 ||
    stats.sessionVideoCompletedNonBoolean > 0
  ) {
    console.warn(
      `[WARN] データ品質: lessonId 非 string=${stats.lessonIdNonString}, exitReason 非 string=${stats.exitReasonNonString}, sessionVideoCompleted 非 boolean=${stats.sessionVideoCompletedNonBoolean}`
    );
  }
  console.log();

  const summary = aggregateSessions(sessions, topLessons);
  printSummary(summary);
}

// ============================================================
// Firestore 取得（read-only）
// ============================================================

/** I/O 層で観測したデータ品質の集計（最後に operator に提示する）。 */
interface IoSkipStats {
  hitFetchCap: boolean;
  fetchedCount: number;
  exitAtMissing: number;
  exitAtMalformed: number;
  outOfRange: number;
  lessonIdNonString: number;
  exitReasonNonString: number;
  sessionVideoCompletedNonBoolean: number;
}

const FETCH_LIMIT = 2000;

async function fetchForceExitsSince(
  db: Firestore,
  tenantId: string,
  since: Date
): Promise<{ sessions: RawSession[]; stats: IoSkipStats }> {
  // status=force_exited に絞ってから exitAt 範囲で再フィルタ（Firestore composite index 回避）。
  // FETCH_LIMIT 到達時は警告し、operator に再設計（composite index + orderBy）を促す。
  const snap = await db
    .collection(`tenants/${tenantId}/lesson_sessions`)
    .where("status", "==", "force_exited")
    .limit(FETCH_LIMIT)
    .get();

  const stats: IoSkipStats = {
    hitFetchCap: snap.size === FETCH_LIMIT,
    fetchedCount: snap.size,
    exitAtMissing: 0,
    exitAtMalformed: 0,
    outOfRange: 0,
    lessonIdNonString: 0,
    exitReasonNonString: 0,
    sessionVideoCompletedNonBoolean: 0,
  };

  const sessions: RawSession[] = [];
  for (const d of snap.docs) {
    const data = d.data() ?? {};

    // exitAt: Timestamp / 有効な ISO 文字列 / null/undefined / その他 の 4 状態に分離
    const exitAtRaw = data.exitAt;
    let exitAtIso: string;
    if (exitAtRaw instanceof Timestamp) {
      exitAtIso = exitAtRaw.toDate().toISOString();
    } else if (typeof exitAtRaw === "string") {
      const parsed = new Date(exitAtRaw);
      if (Number.isNaN(parsed.getTime())) {
        stats.exitAtMalformed++;
        console.warn(
          `[WARN] doc ${d.id}: exitAt 文字列がパース不可 ("${exitAtRaw}")。集計から除外`
        );
        continue;
      }
      exitAtIso = parsed.toISOString();
    } else if (exitAtRaw == null) {
      stats.exitAtMissing++;
      continue;
    } else {
      stats.exitAtMalformed++;
      const ctor = (exitAtRaw as { constructor?: { name?: string } } | null)?.constructor?.name;
      console.warn(
        `[WARN] doc ${d.id}: exitAt が想定外の型 (typeof=${typeof exitAtRaw}, ctor=${ctor ?? "n/a"})。集計から除外`
      );
      continue;
    }

    const exitAtDate = new Date(exitAtIso);
    if (exitAtDate < since) {
      stats.outOfRange++;
      continue;
    }

    // lessonId / exitReason は string 以外を null に正規化し、件数を観測
    let lessonId: string | null;
    if (typeof data.lessonId === "string") {
      lessonId = data.lessonId;
    } else if (data.lessonId == null) {
      lessonId = null;
    } else {
      stats.lessonIdNonString++;
      console.warn(
        `[WARN] doc ${d.id}: lessonId が string でない (typeof=${typeof data.lessonId})。null として扱う`
      );
      lessonId = null;
    }

    let exitReason: string | null;
    if (typeof data.exitReason === "string") {
      exitReason = data.exitReason;
    } else if (data.exitReason == null) {
      exitReason = null;
    } else {
      stats.exitReasonNonString++;
      console.warn(
        `[WARN] doc ${d.id}: exitReason が string でない (typeof=${typeof data.exitReason})。null として扱う`
      );
      exitReason = null;
    }

    // sessionVideoCompleted: boolean 以外（欠落含む）は null として E/B 分類保留
    let sessionVideoCompleted: SessionVideoCompletedFlag;
    if (typeof data.sessionVideoCompleted === "boolean") {
      sessionVideoCompleted = data.sessionVideoCompleted;
    } else {
      sessionVideoCompleted = null;
      stats.sessionVideoCompletedNonBoolean++;
      if (data.sessionVideoCompleted != null) {
        // 欠落（undefined/null）は legacy doc 等で発生し得るため warn まで出さない。
        // 非 boolean の異常値のみ警告して operator に報告。
        console.warn(
          `[WARN] doc ${d.id}: sessionVideoCompleted が boolean でない (typeof=${typeof data.sessionVideoCompleted}, value=${JSON.stringify(
            data.sessionVideoCompleted
          )})。ケース判定不能のため別バケットへ`
        );
      }
    }

    sessions.push({ lessonId, exitReason, sessionVideoCompleted, exitAt: exitAtIso });
  }
  return { sessions, stats };
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
  console.log(
    `  ${summary.timeLimitVideoUnknown
      .toString()
      .padStart(5)}  null （不明: フィールド欠落 / boolean 以外。データ品質要確認、E/B どちらにも算入せず）`
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
