#!/usr/bin/env npx tsx
/**
 * lesson_sessions 複数行候補の読み取り専用監査スクリプト（Stage 6 Phase A、ADR-040）
 *
 * 目的:
 *   出席・テスト結果レポート（/super/attendance）は lesson_sessions を isSynthetic/status で
 *   フィルタせず 1 ドキュメント=1 行でそのまま表示する（super-admin.ts:983-1000, 1039）。
 *   ケースD（有効セッションなしでのテスト合格提出、ADR-027）で作られる合成セッションの
 *   doc id が quiz attempt 単位（synthetic_{attemptId}）のため、同一 (userId, lessonId) に
 *   複数回の合格提出があると複数ドキュメントが作られ、レポート上に複数行として現れうる。
 *   また backfill-synthetic-sessions.ts の categorizeAttempt() は quizAttemptId 完全一致でしか
 *   バックフィル対象外と判定しないため、「実セッション + 後の合成セッション」という
 *   実×合成混在の複数行候補も実在する生成経路がある。
 *
 *   本スクリプトは (userId, lessonId) 単位でグルーピングし、複数行候補を4バケットに分類して
 *   件数を報告する。実際にどの行を正としてどう統合/削除するか（Phase B）は本スクリプトの
 *   スコープ外であり、この監査結果を実測データとして見た上で別PRで設計する。
 *
 * 用語方針:
 *   本スクリプトが検出するのは「重複＝バグ」ではなく「複数行候補」である。
 *   real_only_multi のように正当な再受講の可能性が高いものも含むため、
 *   出力・変数名は「重複」ではなく「候補」「複数行グループ」を用いる。
 *
 * バケット分類（排他的、優先順位順）:
 *   1. mixed_synthetic_real   … synthetic と real が両方存在（最も特異的なシグナル）
 *   2. synthetic_pass_multi   … 全メンバーが synthetic かつ合格経路(synthetic_pass)が2件以上
 *   3. synthetic_skip_multi   … 全メンバーが synthetic かつスキップ経路(synthetic_skip)が2件以上
 *                                （決定的IDにより構造的に発生し得ないはずの異常シグナル）
 *   4. real_only_multi        … 全メンバーが real（正当な再受講の可能性が高いベースライン）
 *
 *   副次シグナルは主バケットと独立に集計する。synthetic_skip が2件以上という条件
 *   （通常なら異常シグナル）は、主バケットが mixed_synthetic_real になっていても
 *   握りつぶさず必ず別途カウントする。
 *
 * 安全機構:
 *   - read-only（書き込み一切なし）
 *   - userId / email は一切出力しない（件数集計のみ）
 *   - doc id も一切出力しない（synthetic_skip_{userId}_{lessonId} は userId を含むため）
 *   - --max-docs-per-tenant 上限到達テナントが1件でもあれば、全体集計は
 *     Phase B の入力として使用不可（INVALID_FOR_PHASE_B）と明示し、終了コード2で終了する
 *   - 本監査は全体スナップショットではない（ページごとの読み取りは走査中の新規作成で
 *     ズレうる）。Phase B 着手直前には必ず再監査すること
 *
 * 使用方法:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *     npx tsx scripts/audit-duplicate-synthetic-sessions.ts \
 *     --tenant-id=8vexhzpc \
 *     --top-lessons=20 \
 *     --max-docs-per-tenant=20000
 *
 *   --tenant-id 省略時は全テナント横断で走査する。
 *
 * 環境変数:
 *   GOOGLE_APPLICATION_CREDENTIALS  サービスアカウント JSON のパス（WIF 環境では external_account JSON）
 *   GOOGLE_CLOUD_PROJECT            プロジェクト ID
 */

import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { initFirestoreForCli } from "./lib/init-firebase-admin.js";
import { JST_OFFSET_MS } from "@lms-279/shared-types";

// ============================================================
// 純粋関数（smoke test 対象）
// ============================================================

export type SessionKind = "synthetic_skip" | "synthetic_pass" | "real";

export type GroupBucket =
  | "mixed_synthetic_real"
  | "synthetic_pass_multi"
  | "synthetic_skip_multi"
  | "real_only_multi";

export const ALL_BUCKETS: readonly GroupBucket[] = [
  "mixed_synthetic_real",
  "synthetic_pass_multi",
  "synthetic_skip_multi",
  "real_only_multi",
];

export type TimestampKind = "timestamp" | "string" | "missing" | "malformed";

export interface NormalizedTimestamp {
  readonly iso: string | null;
  readonly kind: TimestampKind;
}

/**
 * doc id から種別を判定する（決定的ID規約に基づく唯一の判定根拠）。
 * synthetic_skip_{userId}_{lessonId} と synthetic_{attemptId} はどちらも
 * "synthetic_" prefix を共有するため、skip の判定を必ず先に行う。
 */
export function classifyKind(docId: string): SessionKind {
  if (docId.startsWith("synthetic_skip_")) return "synthetic_skip";
  if (docId.startsWith("synthetic_")) return "synthetic_pass";
  return "real";
}

/**
 * isSynthetic フィールドと doc id prefix のクロスチェック。
 * 不一致は legacy doc や想定外の書き込み経路を示すデータ品質シグナル
 * （欠落＝null は「不一致」ではなく別途 missing として扱うため対象外）。
 */
export function hasKindFlagMismatch(kind: SessionKind, isSyntheticFlag: boolean | null): boolean {
  if (isSyntheticFlag === null) return false;
  const expectedSynthetic = kind !== "real";
  return isSyntheticFlag !== expectedSynthetic;
}

/** synthetic_{attemptId} 形式の doc id から attemptId を取り出す（skip 形式は対象外）。 */
export function extractAttemptIdFromSyntheticPassDocId(docId: string): string | null {
  if (classifyKind(docId) !== "synthetic_pass") return null;
  const attemptId = docId.slice("synthetic_".length);
  return attemptId.length > 0 ? attemptId : null;
}

/**
 * Timestamp / ISO文字列 / 欠落 / それ以外 の4状態に正規化する
 * （audit-session-force-exits.ts の tri-state 正規化パターンを踏襲）。
 */
export function normalizeTimestamp(v: unknown): NormalizedTimestamp {
  if (v == null) return { iso: null, kind: "missing" };
  if (v instanceof Timestamp) {
    return { iso: v.toDate().toISOString(), kind: "timestamp" };
  }
  if (typeof v === "string") {
    const parsed = new Date(v);
    if (Number.isNaN(parsed.getTime())) return { iso: null, kind: "malformed" };
    return { iso: parsed.toISOString(), kind: "string" };
  }
  return { iso: null, kind: "malformed" };
}

/** JST（UTC+9）基準の日付文字列（YYYY-MM-DD）。super-admin.ts の JST_OFFSET_MS 換算と同一方式。 */
export function jstDateOf(iso: string): string {
  const jst = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return jst.toISOString().slice(0, 10);
}

export interface IntervalLike {
  readonly entryAt: string | null;
  readonly exitAt: string | null;
}

/**
 * 2つのセッションの [entryAt, exitAt] 区間が重なるか。
 * entryAt が欠落/不正な区間は比較不能として false（比較しない）。
 * exitAt が null（未完了）は開区間として扱う。
 */
export function intervalsOverlap(a: IntervalLike, b: IntervalLike): boolean {
  if (a.entryAt === null || b.entryAt === null) return false;
  const aStart = new Date(a.entryAt).getTime();
  const aEnd = a.exitAt !== null ? new Date(a.exitAt).getTime() : Number.POSITIVE_INFINITY;
  const bStart = new Date(b.entryAt).getTime();
  const bEnd = b.exitAt !== null ? new Date(b.exitAt).getTime() : Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
}

export interface RawSessionDoc {
  readonly docId: string;
  readonly userId: string | null;
  readonly lessonId: string | null;
  readonly status: string | null;
  readonly exitReason: string | null;
  readonly entryAt: string | null;
  readonly exitAt: string | null;
  readonly quizAttemptId: string | null;
  readonly isSyntheticFlag: boolean | null;
  readonly hasOriginal: boolean;
  readonly hasEditedAt: boolean;
}

/** Firestore doc の生データ（`doc.data()` 相当）から RawSessionDoc へ正規化する。 */
export function mapRawDocToSessionDoc(docId: string, data: Record<string, unknown>): RawSessionDoc {
  const userId = typeof data.userId === "string" ? data.userId : null;
  const lessonId = typeof data.lessonId === "string" ? data.lessonId : null;
  const status = typeof data.status === "string" ? data.status : null;
  const exitReason = typeof data.exitReason === "string" ? data.exitReason : null;
  const entryAt = normalizeTimestamp(data.entryAt).iso;
  const exitAt = normalizeTimestamp(data.exitAt).iso;
  const quizAttemptId = typeof data.quizAttemptId === "string" ? data.quizAttemptId : null;
  const isSyntheticFlag = typeof data.isSynthetic === "boolean" ? data.isSynthetic : null;
  // original/editedAt は「フィールドとして存在するか」で判定する（truthy 判定ではない）。
  // super-admin.ts の PATCH は original を immutable snapshot として一度だけ書き込むため、
  // 値の中身ではなく「キーの存在」が super-admin 手動編集済みかどうかの正しい判定基準。
  const hasOriginal = "original" in data && data.original !== undefined;
  const hasEditedAt = "editedAt" in data && data.editedAt !== undefined;
  return {
    docId,
    userId,
    lessonId,
    status,
    exitReason,
    entryAt,
    exitAt,
    quizAttemptId,
    isSyntheticFlag,
    hasOriginal,
    hasEditedAt,
  };
}

export interface DuplicateGroup {
  readonly userId: string;
  readonly lessonId: string;
  readonly members: readonly RawSessionDoc[];
}

export interface GroupingResult {
  readonly groups: readonly DuplicateGroup[];
  readonly missingUserId: number;
  readonly missingLessonId: number;
}

/**
 * (userId, lessonId) でグルーピングし、size>=2 のグループのみを返す。
 * userId/lessonId が欠落しているドキュメントは、同一キーとして誤って
 * 巨大な擬似グループを作らないよう除外し、個別カウントする。
 */
export function groupByUserLesson(docs: readonly RawSessionDoc[]): GroupingResult {
  let missingUserId = 0;
  let missingLessonId = 0;
  const map = new Map<string, RawSessionDoc[]>();

  for (const d of docs) {
    if (d.userId === null) {
      missingUserId++;
      continue;
    }
    if (d.lessonId === null) {
      missingLessonId++;
      continue;
    }
    // NUL区切り: userId/lessonId 自体に任意の文字が含まれても他のキーと衝突しない
    const key = `${d.userId} ${d.lessonId}`;
    const arr = map.get(key);
    if (arr) {
      arr.push(d);
    } else {
      map.set(key, [d]);
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, members] of map) {
    if (members.length < 2) continue;
    const [userId, lessonId] = key.split(" ");
    groups.push({ userId, lessonId, members });
  }

  return { groups, missingUserId, missingLessonId };
}

export interface GroupClassification {
  readonly bucket: GroupBucket;
  readonly isProtected: boolean;
  readonly syntheticPassCount: number;
  readonly syntheticSkipCount: number;
  readonly realCount: number;
  /** synthetic_skip が2件以上という異常シグナル。主バケットに関わらず必ず立てる。 */
  readonly hasSkipMultiAnomaly: boolean;
  /** 実セッションのquizAttemptIdが、合成(合格)セッションのdoc idと一致する調査シグナル（証拠ではない）。 */
  readonly sameAttemptSignal: boolean;
  readonly intervalOverlap: boolean;
  readonly sameJstDate: boolean;
}

/** グループを主バケットへ排他的に分類し、副次シグナルを付与する。 */
export function classifyGroup(group: DuplicateGroup): GroupClassification {
  const kinds = group.members.map((m) => classifyKind(m.docId));
  const syntheticPassCount = kinds.filter((k) => k === "synthetic_pass").length;
  const syntheticSkipCount = kinds.filter((k) => k === "synthetic_skip").length;
  const realCount = kinds.filter((k) => k === "real").length;
  const hasSynthetic = syntheticPassCount + syntheticSkipCount > 0;
  const hasReal = realCount > 0;

  let bucket: GroupBucket;
  if (hasSynthetic && hasReal) {
    bucket = "mixed_synthetic_real";
  } else if (!hasReal && syntheticPassCount >= 2) {
    bucket = "synthetic_pass_multi";
  } else if (!hasReal && syntheticSkipCount >= 2) {
    bucket = "synthetic_skip_multi";
  } else {
    bucket = "real_only_multi";
  }

  const isProtected = group.members.some((m) => m.hasOriginal || m.hasEditedAt);
  const hasSkipMultiAnomaly = syntheticSkipCount >= 2;

  const syntheticPassAttemptIds = new Set(
    group.members
      .map((m) => extractAttemptIdFromSyntheticPassDocId(m.docId))
      .filter((x): x is string => x !== null)
  );
  const sameAttemptSignal = group.members.some(
    (m) =>
      classifyKind(m.docId) === "real" &&
      m.quizAttemptId !== null &&
      syntheticPassAttemptIds.has(m.quizAttemptId)
  );

  let intervalOverlap = false;
  for (let i = 0; i < group.members.length && !intervalOverlap; i++) {
    for (let j = i + 1; j < group.members.length && !intervalOverlap; j++) {
      if (intervalsOverlap(group.members[i], group.members[j])) intervalOverlap = true;
    }
  }

  const dates = group.members
    .map((m) => (m.entryAt !== null ? jstDateOf(m.entryAt) : null))
    .filter((x): x is string => x !== null);
  const sameJstDate = dates.length === group.members.length && new Set(dates).size === 1;

  return {
    bucket,
    isProtected,
    syntheticPassCount,
    syntheticSkipCount,
    realCount,
    hasSkipMultiAnomaly,
    sameAttemptSignal,
    intervalOverlap,
    sameJstDate,
  };
}

// ============================================================
// ページング（依存性注入可能、smoke test は実体を直接検証する）
// ============================================================

export interface FetchedDoc {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

export interface FetchedPage {
  readonly docs: readonly FetchedDoc[];
}

/** ページ取得の抽象。本番では Firestore、smoke test ではスタブを注入する。 */
export interface PageFetcher {
  fetchPage(afterDocId: string | null, pageSize: number): Promise<FetchedPage>;
}

export interface ScanResult {
  readonly docs: readonly RawSessionDoc[];
  readonly docsRead: number;
  readonly pageCount: number;
  readonly hitDocCap: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * FieldPath.documentId() 順でページング全件取得する（複合indexを必要としない）。
 * `--max-docs-per-tenant` 上限に達した場合は hitDocCap=true とし、その時点までの
 * 部分データを返す（呼び出し側で全体集計を INVALID_FOR_PHASE_B として扱う）。
 */
export async function scanTenantLessonSessions(
  fetcher: PageFetcher,
  maxDocsPerTenant: number,
  pageSize = 1000
): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const rawDocs: FetchedDoc[] = [];
  let afterDocId: string | null = null;
  let pageCount = 0;
  let hitDocCap = false;

  for (;;) {
    const page = await fetcher.fetchPage(afterDocId, pageSize);
    pageCount++;
    if (page.docs.length === 0) break;

    for (const doc of page.docs) {
      if (rawDocs.length >= maxDocsPerTenant) {
        hitDocCap = true;
        break;
      }
      rawDocs.push(doc);
    }
    if (hitDocCap) break;
    if (page.docs.length < pageSize) break; // 最終ページ
    afterDocId = page.docs[page.docs.length - 1].id;
  }

  const docs = rawDocs.map((d) => mapRawDocToSessionDoc(d.id, d.data));
  const finishedAt = new Date().toISOString();
  return { docs, docsRead: docs.length, pageCount, hitDocCap, startedAt, finishedAt };
}

// ============================================================
// 集計（純粋関数）
// ============================================================

export interface DataQuality {
  readonly missingUserId: number;
  readonly missingLessonId: number;
  readonly malformedEntryAt: number;
  readonly malformedExitAt: number;
  readonly kindFlagMismatch: number;
}

export interface BucketSummary {
  readonly groupCount: number;
  readonly totalDocs: number;
  /** レポート上の余剰行数（size - 1 の合計）。運用上の関心はこの数値。 */
  readonly excessRows: number;
  readonly protectedGroupCount: number;
  readonly safeGroupCount: number;
}

export interface MixedSecondarySummary {
  readonly sameAttemptSignalCount: number;
  readonly overlapCount: number;
  readonly sameDateCount: number;
  readonly syntheticPassMultiWithinMixedCount: number;
}

export interface ScanMeta {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly pageCount: number;
  readonly docsRead: number;
  readonly hitDocCap: boolean;
}

export interface LessonGroupCount {
  readonly lessonId: string;
  readonly groupCount: number;
}

export interface TenantDuplicateSummary {
  readonly tenantId: string;
  readonly scan: ScanMeta;
  readonly dataQuality: DataQuality;
  readonly buckets: Readonly<Record<GroupBucket, BucketSummary>>;
  readonly mixedSecondary: MixedSecondarySummary;
  readonly skipMultiAnomalyCount: number;
  readonly topLessons: readonly LessonGroupCount[];
  readonly topLessonsTruncated: number;
}

function emptyBucketSummary(): BucketSummary {
  return { groupCount: 0, totalDocs: 0, excessRows: 0, protectedGroupCount: 0, safeGroupCount: 0 };
}

/**
 * テナント1件分の集計。scanTenantLessonSessions の結果 + malformed timestamp件数を受け取り、
 * グルーピング・分類・バケット集計・上位lessonId集計をまとめて行う。
 */
export function aggregateTenant(
  tenantId: string,
  docs: readonly RawSessionDoc[],
  scan: ScanMeta,
  malformedEntryAt: number,
  malformedExitAt: number,
  topLessonsN: number
): TenantDuplicateSummary {
  const kindFlagMismatch = docs.filter((d) => hasKindFlagMismatch(classifyKind(d.docId), d.isSyntheticFlag)).length;
  const { groups, missingUserId, missingLessonId } = groupByUserLesson(docs);

  const buckets: Record<GroupBucket, BucketSummary> = {
    mixed_synthetic_real: emptyBucketSummary(),
    synthetic_pass_multi: emptyBucketSummary(),
    synthetic_skip_multi: emptyBucketSummary(),
    real_only_multi: emptyBucketSummary(),
  };

  let sameAttemptSignalCount = 0;
  let overlapCount = 0;
  let sameDateCount = 0;
  let syntheticPassMultiWithinMixedCount = 0;
  let skipMultiAnomalyCount = 0;
  const lessonGroupCounts = new Map<string, number>();

  for (const group of groups) {
    const c = classifyGroup(group);
    const b = buckets[c.bucket];
    buckets[c.bucket] = {
      groupCount: b.groupCount + 1,
      totalDocs: b.totalDocs + group.members.length,
      excessRows: b.excessRows + (group.members.length - 1),
      protectedGroupCount: b.protectedGroupCount + (c.isProtected ? 1 : 0),
      safeGroupCount: b.safeGroupCount + (c.isProtected ? 0 : 1),
    };

    if (c.bucket === "mixed_synthetic_real") {
      if (c.sameAttemptSignal) sameAttemptSignalCount++;
      if (c.intervalOverlap) overlapCount++;
      if (c.sameJstDate) sameDateCount++;
      if (c.syntheticPassCount >= 2) syntheticPassMultiWithinMixedCount++;
    }
    if (c.hasSkipMultiAnomaly) skipMultiAnomalyCount++;

    lessonGroupCounts.set(group.lessonId, (lessonGroupCounts.get(group.lessonId) ?? 0) + 1);
  }

  const allTopLessons = Array.from(lessonGroupCounts.entries())
    .map(([lessonId, groupCount]) => ({ lessonId, groupCount }))
    .sort((a, b) => b.groupCount - a.groupCount);
  const topLessons = allTopLessons.slice(0, topLessonsN);
  const topLessonsTruncated = Math.max(0, allTopLessons.length - topLessonsN);

  return {
    tenantId,
    scan,
    dataQuality: { missingUserId, missingLessonId, malformedEntryAt, malformedExitAt, kindFlagMismatch },
    buckets,
    mixedSecondary: {
      sameAttemptSignalCount,
      overlapCount,
      sameDateCount,
      syntheticPassMultiWithinMixedCount,
    },
    skipMultiAnomalyCount,
    topLessons,
    topLessonsTruncated,
  };
}

export interface GrandTotal {
  readonly tenantCount: number;
  readonly totalGroupCount: number;
  readonly totalExcessRows: number;
  readonly totalProtectedGroupCount: number;
  readonly capHitTenantCount: number;
  /** true の場合、本結果は Phase B 設計の入力として使用してはならない。 */
  readonly invalidForPhaseB: boolean;
}

/** テナント別集計をスカラーのみ合算する（lessonId はテナントスコープのため横断集計しない）。 */
export function mergeSummaries(summaries: readonly TenantDuplicateSummary[]): GrandTotal {
  let totalGroupCount = 0;
  let totalExcessRows = 0;
  let totalProtectedGroupCount = 0;
  let capHitTenantCount = 0;

  for (const s of summaries) {
    for (const bucket of ALL_BUCKETS) {
      const b = s.buckets[bucket];
      totalGroupCount += b.groupCount;
      totalExcessRows += b.excessRows;
      totalProtectedGroupCount += b.protectedGroupCount;
    }
    if (s.scan.hitDocCap) capHitTenantCount++;
  }

  return {
    tenantCount: summaries.length,
    totalGroupCount,
    totalExcessRows,
    totalProtectedGroupCount,
    capHitTenantCount,
    invalidForPhaseB: capHitTenantCount > 0,
  };
}

// ============================================================
// CLI / メイン
// ============================================================

const ARG_PREFIXES = ["--tenant-id=", "--top-lessons=", "--max-docs-per-tenant="] as const;

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

  const tenantIdRaw = args
    .find((a) => a.startsWith("--tenant-id="))
    ?.replace("--tenant-id=", "")
    .trim();
  if (tenantIdRaw && !/^[A-Za-z0-9_-]+$/.test(tenantIdRaw)) {
    console.error(`[FATAL] --tenant-id の形式が不正（英数/_/-のみ許可）: "${tenantIdRaw}"`);
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

  const maxDocsRaw = args
    .find((a) => a.startsWith("--max-docs-per-tenant="))
    ?.replace("--max-docs-per-tenant=", "")
    .trim();
  const maxDocsPerTenant = maxDocsRaw ? Number(maxDocsRaw) : 20000;
  if (!Number.isInteger(maxDocsPerTenant) || maxDocsPerTenant <= 0 || maxDocsPerTenant > 200000) {
    console.error(`[FATAL] --max-docs-per-tenant は 1〜200000 の整数: 受け取った値="${maxDocsRaw}"`);
    process.exit(1);
  }

  const db = initFirestoreForCli();

  console.log("=== lesson_sessions 複数行候補の監査（read-only、Stage 6 Phase A） ===");
  console.log(`対象テナント: ${tenantIdRaw ?? "(全テナント横断)"}`);
  console.log(`lesson 別表示上位件数: ${topLessons}`);
  console.log(`テナントあたり上限読み取り件数: ${maxDocsPerTenant}`);
  console.log();

  let tenantIds: string[];
  if (tenantIdRaw) {
    const tenantDoc = await db.collection("tenants").doc(tenantIdRaw).get();
    if (!tenantDoc.exists) {
      console.error(`[FATAL] tenant not found: ${tenantIdRaw}`);
      process.exit(1);
    }
    tenantIds = [tenantIdRaw];
  } else {
    const tenantsSnap = await db.collection("tenants").get();
    if (tenantsSnap.empty) {
      console.error("[FATAL] tenants collection が空です");
      process.exit(1);
    }
    tenantIds = tenantsSnap.docs.map((d) => d.id);
  }

  const summaries: TenantDuplicateSummary[] = [];
  for (const tenantId of tenantIds) {
    const coll = db.collection(`tenants/${tenantId}/lesson_sessions`);
    const fetcher: PageFetcher = {
      async fetchPage(afterDocId, pageSize) {
        let q = coll.orderBy(FieldPath.documentId()).limit(pageSize);
        if (afterDocId !== null) q = q.startAfter(afterDocId);
        const snap = await q.get();
        return { docs: snap.docs.map((d) => ({ id: d.id, data: d.data() })) };
      },
    };

    const scanResult = await scanTenantLessonSessions(fetcher, maxDocsPerTenant);
    if (scanResult.hitDocCap) {
      console.warn(
        `[WARN] tenant ${tenantId}: --max-docs-per-tenant=${maxDocsPerTenant} に到達。この実行結果全体を Phase B の入力に使ってはならない`
      );
    }

    const malformedEntryAt = scanResult.docs.filter((d) => d.entryAt === null).length;
    const malformedExitAt = 0; // exitAt=null は未完了セッションの正常値のため、ここでは entryAt malformed のみカウント

    const scanMeta: ScanMeta = {
      startedAt: scanResult.startedAt,
      finishedAt: scanResult.finishedAt,
      pageCount: scanResult.pageCount,
      docsRead: scanResult.docsRead,
      hitDocCap: scanResult.hitDocCap,
    };

    const summary = aggregateTenant(tenantId, scanResult.docs, scanMeta, malformedEntryAt, malformedExitAt, topLessons);
    summaries.push(summary);
    printTenantSummary(summary);
  }

  const grandTotal = mergeSummaries(summaries);
  printGrandTotal(grandTotal);

  if (grandTotal.invalidForPhaseB) {
    process.exit(2);
  }
}

// ============================================================
// 出力
// ============================================================

const BUCKET_LABELS: Record<GroupBucket, string> = {
  mixed_synthetic_real: "real+synthetic 混在候補",
  synthetic_pass_multi: "synthetic(合格経路) 複数候補",
  synthetic_skip_multi: "synthetic(スキップ経路) 複数候補 [構造的に異常]",
  real_only_multi: "real のみ複数（正当な再受講の可能性が高いベースライン）",
};

export function printTenantSummary(s: TenantDuplicateSummary): void {
  console.log(`--- tenant: ${s.tenantId} ---`);
  console.log(
    `走査: ${s.scan.startedAt} 〜 ${s.scan.finishedAt} (${s.scan.pageCount} ページ, ${s.scan.docsRead} 件読み取り${
      s.scan.hitDocCap ? ", 上限到達=INVALID" : ""
    })`
  );
  if (s.dataQuality.missingUserId || s.dataQuality.missingLessonId || s.dataQuality.malformedEntryAt || s.dataQuality.kindFlagMismatch) {
    console.log(
      `データ品質: userId欠落=${s.dataQuality.missingUserId} lessonId欠落=${s.dataQuality.missingLessonId} entryAt不正=${s.dataQuality.malformedEntryAt} kind/flag不一致=${s.dataQuality.kindFlagMismatch}`
    );
  }
  console.log("複数行候補グループ:");
  for (const bucket of ALL_BUCKETS) {
    const b = s.buckets[bucket];
    console.log(
      `  ${BUCKET_LABELS[bucket]}: グループ${b.groupCount}件 / 余剰行${b.excessRows}行 (protected=${b.protectedGroupCount} safe=${b.safeGroupCount})`
    );
  }
  console.log(
    `  [異常シグナル] synthetic_skip 2件以上を含むグループ数（主バケット問わず）: ${s.skipMultiAnomalyCount}`
  );
  console.log(
    `  [mixed副次シグナル] 同一attemptId調査シグナル=${s.mixedSecondary.sameAttemptSignalCount} 時間重複=${s.mixedSecondary.overlapCount} 同一JST日付=${s.mixedSecondary.sameDateCount} mixed内synthetic_pass複数=${s.mixedSecondary.syntheticPassMultiWithinMixedCount}`
  );
  if (s.topLessons.length > 0) {
    console.log("  lesson別グループ数(上位):");
    for (const { lessonId, groupCount } of s.topLessons) {
      console.log(`    ${groupCount.toString().padStart(5)}  ${lessonId}`);
    }
    if (s.topLessonsTruncated > 0) {
      console.log(`    ...他 ${s.topLessonsTruncated} lesson 省略`);
    }
  }
  console.log();
}

export function printGrandTotal(g: GrandTotal): void {
  console.log("=== 全体集計 ===");
  console.log(`テナント数: ${g.tenantCount}`);
  console.log(`複数行候補グループ総数: ${g.totalGroupCount}`);
  console.log(`余剰行総数: ${g.totalExcessRows}`);
  console.log(`protected（super-admin手動編集済み、Phase Bで不可侵）グループ数: ${g.totalProtectedGroupCount}`);
  if (g.invalidForPhaseB) {
    console.log();
    console.log(
      `[INVALID_FOR_PHASE_B] ${g.capHitTenantCount} テナントで --max-docs-per-tenant 上限に到達したため、この実行の全体集計は不完全です。`
    );
    console.log(
      "[INVALID_FOR_PHASE_B] この結果を Phase B（統合/削除）設計の入力として使用しないでください。上限を引き上げて再実行してください。"
    );
  } else {
    console.log();
    console.log("本監査は時点整合スナップショットではありません。Phase B 着手直前には必ず再監査してください。");
  }
}
