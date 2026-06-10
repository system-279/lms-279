#!/usr/bin/env npx tsx
/**
 * 過去の活動セッション欠落 lesson_session を遡及作成 (#533 Phase 2)
 *
 * 背景:
 * `quiz-attempts.ts` は後方互換のため activeSession=null でもテスト提出を許可する設計
 * (services/api/src/routes/shared/quiz-attempts.ts:292-294)。
 * Phase 1 (PR #537) で新規発生は createSyntheticCompletedSession ヘルパーにより予防済み。
 * 本スクリプトは Phase 1 投入前に発生した過去分 (長遊園テナント 4 件等) を遡及補正する。
 *
 * 検出ロジック (categorizeAttempt):
 *   - status !== "submitted" or isPassed !== true → skip (not relevant)
 *   - startedAt or submittedAt 欠落 → skip (invalid data, log warn)
 *   - related lesson_sessions に quizAttemptId === attempt.id の doc が 0 件 → "backfill_target"
 *   - related lesson_sessions に quizAttemptId 一致 doc あり → "audit_only" (別問題、apply 対象外)
 *
 * 書き込み内容 (Phase 1 createSyntheticCompletedSession 相当):
 *   - doc id: synthetic_{attemptId}  (決定的、tx.create で race-safe + 冪等)
 *   - entryAt: attempt.startedAt, exitAt: attempt.submittedAt
 *   - status: "completed", exitReason: "quiz_submitted"
 *   - isSynthetic: true, sessionVideoCompleted: true
 *   - sessionToken: synthetic-{attemptId}
 *   - deadlineAt: entryAt + SESSION_DURATION_MS (completed では未使用だが型は必須)
 *
 * 安全機構:
 *   1. dry-run 既定 (--execute で実行)
 *   2. expected_count 完全一致ガード (--expected-count=N で対象数が違えば fail)
 *   3. max_targets 上限 (--max-targets=N、既定 100)
 *   4. スコープ絞り込み (--tenant-id / --user-id / --user-email、--user-id/-email 排他)
 *   5. backup JSON (commit SHA / run id / actor / project id / attempt + related sessions snapshot)
 *   6. tx.create で ALREADY_EXISTS は skip 扱い (race / リトライで安全)
 *   7. 読み戻し検証 (apply 後の synthetic doc を再取得し全フィールド一致確認)
 *
 * 使用方法:
 *   # audit (検出のみ、件数 + サンプル表示)
 *   npx tsx scripts/backfill-synthetic-sessions.ts
 *
 *   # 特定テナント
 *   npx tsx scripts/backfill-synthetic-sessions.ts --tenant-id=xxx
 *
 *   # 特定ユーザー
 *   npx tsx scripts/backfill-synthetic-sessions.ts --user-email=foo@bar.com
 *
 *   # 実行 (本番では expected-count 必須運用)
 *   npx tsx scripts/backfill-synthetic-sessions.ts --execute --expected-count=4
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
import { parsePositiveDurationMs } from "../services/api/src/utils/env-config.js";

// ============================================================
// 定数
// ============================================================

// セッション期間 (ミリ秒)。Phase 1 helper (services/api/src/services/lesson-session.ts:16)
// は env SESSION_DURATION_MS を parsePositiveDurationMs で読み、本番 Cloud Run では
// 10800000 (3h) で稼働。本 script も同じ env / helper を用いて Phase 1 と完全に揃える。
// completed session の deadlineAt は意味的に未使用だが、orderBy 等で混在しないため一致が望ましい。
const SESSION_DURATION_MS_FALLBACK = 7_200_000;
// 24 時間上限: Date 範囲外 (例: 1e20 ms) で RangeError を防ぐ scripts 専用の安全策。
// Phase 1 ランタイムは Cloud Run env で安定値が入るため上限不要、本 script は環境変数の typo を
// 監視できないため上限を別途設ける。
const SESSION_DURATION_MS_MAX = 86_400_000;
export function resolveSessionDurationMs(envValue: string | undefined): number {
  const parsed = parsePositiveDurationMs(
    envValue,
    SESSION_DURATION_MS_FALLBACK,
    "SESSION_DURATION_MS"
  );
  if (parsed > SESSION_DURATION_MS_MAX) {
    console.warn(
      `[WARN] SESSION_DURATION_MS=${parsed} は 24h (${SESSION_DURATION_MS_MAX}) を超えるため fallback ${SESSION_DURATION_MS_FALLBACK} を使用`
    );
    return SESSION_DURATION_MS_FALLBACK;
  }
  return parsed;
}
const DEFAULT_SESSION_DURATION_MS = resolveSessionDurationMs(
  process.env.SESSION_DURATION_MS
);

// ============================================================
// 型定義 (純粋関数 + 永続層共通)
// ============================================================

export interface AttemptInfo {
  id: string;
  status: string;
  isPassed: boolean | null;
  startedAt: string | null;
  submittedAt: string | null;
  quizId: string;
  userId: string;
  attemptNumber: number;
  score: number | null;
}

export interface SessionInfo {
  id: string;
  userId: string;
  lessonId: string;
  courseId: string;
  videoId: string;
  status: string;
  entryAt: string;
  exitAt: string | null;
  exitReason: string | null;
  quizAttemptId: string | null;
  isSynthetic?: boolean;
}

export type BackfillCategory = "backfill_target" | "audit_only" | null;

export interface SyntheticSessionData {
  userId: string;
  lessonId: string;
  courseId: string;
  videoId: string;
  sessionToken: string;
  status: "completed";
  entryAt: string;
  exitAt: string;
  exitReason: "quiz_submitted";
  deadlineAt: string;
  pauseStartedAt: null;
  longestPauseSec: 0;
  sessionVideoCompleted: true;
  quizAttemptId: string;
  isSynthetic: true;
}

/**
 * Phase 3 follow-up #4 (D 案): 過去 synthetic doc の exitAt 上書き更新用カテゴリ。
 * - update_target: 旧形式 synthetic doc (exitAt === quiz.submittedAt && entryAt === quiz.startedAt) + original/editedAt なし
 * - skip_edited: original または editedAt あり (PR #557 手動編集済、保護)
 * - skip_not_legacy: 既に新形式 or 別形式 → 更新対象外
 * - skip_no_synthetic: synthetic doc 不在
 */
export type BackfillUpdateCategory =
  | "update_target"
  | "skip_edited"
  | "skip_not_legacy"
  | "skip_no_synthetic"
  | "skip_invalid_attempt";

/**
 * Firestore に書き込む完全な payload 形 (タイムスタンプを含む)。
 * Phase 1 createLessonSessionWithId と一致させるため createdAt/updatedAt は Date オブジェクト
 * (Firestore admin SDK が自動で Timestamp 型に変換、string 渡しと型が divergent するのを防ぐ)。
 */
export interface SyntheticSessionWritePayload extends SyntheticSessionData {
  createdAt: Date;
  updatedAt: Date;
}

export function buildWritePayload(
  planned: SyntheticSessionData,
  now: Date
): SyntheticSessionWritePayload {
  return { ...planned, createdAt: now, updatedAt: now };
}

// ============================================================
// 純粋関数 (smoke + unit test 対象)
// ============================================================

/**
 * attempt の補正カテゴリを判定する純粋関数。
 *
 * Codex 指摘反映:
 *   - status は "passed" ではなく "submitted" + isPassed === true (正しい型)
 *   - 「quizAttemptId 付き session あり + status=abandoned 等」は audit_only カテゴリで分離、apply 対象外
 */
export function categorizeAttempt(
  attempt: AttemptInfo,
  relatedSessions: SessionInfo[]
): BackfillCategory {
  // 合格提出のみ対象
  if (attempt.status !== "submitted" || attempt.isPassed !== true) return null;
  // タイムスタンプ欠落は skip (呼び出し元で warn ログ)
  if (!attempt.startedAt || !attempt.submittedAt) return null;

  // 同じ attempt に紐づく session が既にあるか
  const linkedSessions = relatedSessions.filter(
    (s) => s.quizAttemptId === attempt.id
  );
  if (linkedSessions.length > 0) {
    // 既存 link あり → 別問題 (例: abandoned で残った session)、apply はしない
    return "audit_only";
  }

  return "backfill_target";
}

/**
 * 合成 session の書き込み内容を構築する純粋関数。
 * Phase 1 createSyntheticCompletedSession と完全に同じフィールドを生成する。
 */
export function buildSyntheticSessionData(
  attempt: AttemptInfo,
  lessonId: string,
  courseId: string,
  videoId: string,
  sessionDurationMs: number = DEFAULT_SESSION_DURATION_MS
): SyntheticSessionData {
  if (!attempt.startedAt || !attempt.submittedAt) {
    throw new Error(
      `buildSyntheticSessionData: attempt ${attempt.id} に startedAt/submittedAt が欠落`
    );
  }
  const startedMs = new Date(attempt.startedAt).getTime();
  const deadlineAt = new Date(startedMs + sessionDurationMs).toISOString();
  return {
    userId: attempt.userId,
    lessonId,
    courseId,
    videoId,
    sessionToken: `synthetic-${attempt.id}`,
    status: "completed",
    entryAt: attempt.startedAt,
    exitAt: attempt.submittedAt,
    exitReason: "quiz_submitted",
    deadlineAt,
    pauseStartedAt: null,
    longestPauseSec: 0,
    sessionVideoCompleted: true,
    quizAttemptId: attempt.id,
    isSynthetic: true,
  };
}

/**
 * Phase 3 follow-up #4 (D 案): update-existing モード用の判定純粋関数。
 *
 * 旧形式 synthetic doc (Phase 1/2 で作成された exitAt = quiz.submittedAt のもの) を
 * D 案ロジック (exitAt = startedAt + videoDurationMs + quizDurationMs) で更新する対象を判定する。
 *
 * Codex セカンドオピニオン 4 ラウンド目指摘反映:
 *   - editedAt / original 両方を判定 (PR #557 後の no-op 更新でも片方付与され得る)
 *   - 旧形式判定は exitAt === submittedAt + entryAt === startedAt の両方を確認 (transaction 内でも再検証)
 */
export function categorizeAttemptForUpdate(
  attempt: AttemptInfo,
  relatedSessions: Array<SessionInfo & { editedAt?: string; original?: unknown }>
): BackfillUpdateCategory {
  if (attempt.status !== "submitted" || attempt.isPassed !== true) {
    return "skip_invalid_attempt";
  }
  if (!attempt.startedAt || !attempt.submittedAt) {
    return "skip_invalid_attempt";
  }

  const synthetic = relatedSessions.find(
    (s) => s.id === `synthetic_${attempt.id}` && s.isSynthetic === true
  );
  if (!synthetic) return "skip_no_synthetic";

  // PR #557 手動編集済 doc は保護
  if (synthetic.original !== undefined && synthetic.original !== null) return "skip_edited";
  if (synthetic.editedAt !== undefined && synthetic.editedAt !== null) return "skip_edited";

  // 旧形式判定 (entryAt と exitAt 両方が attempt 値と一致)
  if (synthetic.entryAt !== attempt.startedAt) return "skip_not_legacy";
  if (synthetic.exitAt !== attempt.submittedAt) return "skip_not_legacy";

  return "update_target";
}

/**
 * D 案の exitAt 算出 (Phase 3 follow-up #4)。
 * videoDurationSec hard guard (Codex 指摘 #2): Number.isFinite + > 0 を満たさない場合 throw。
 */
export function buildUpdatedExitAt(
  attempt: AttemptInfo,
  videoDurationSec: number
): string {
  if (!Number.isFinite(videoDurationSec) || videoDurationSec <= 0) {
    throw new Error(
      `buildUpdatedExitAt: invalid videoDurationSec=${videoDurationSec} for attempt ${attempt.id}`
    );
  }
  if (!attempt.startedAt || !attempt.submittedAt) {
    throw new Error(
      `buildUpdatedExitAt: attempt ${attempt.id} に startedAt/submittedAt が欠落`
    );
  }
  const startedMs = new Date(attempt.startedAt).getTime();
  const submittedMs = new Date(attempt.submittedAt).getTime();
  const quizDurationMs = submittedMs - startedMs;
  return new Date(startedMs + videoDurationSec * 1000 + quizDurationMs).toISOString();
}

/**
 * tenant 別 expected count 検証 (Codex 指摘 #4 反映)。
 * 全体 17 + tenant 別 12/5 を両方検証することで、想定外のテナントが含まれていないか機械的に確認。
 */
export function validateTenantBreakdown(
  actualBreakdown: Map<string, number>,
  expectedBreakdown: Map<string, number>
): { ok: boolean; reason?: string } {
  if (expectedBreakdown.size === 0) return { ok: true };
  const mismatches: string[] = [];
  for (const [tid, expected] of expectedBreakdown) {
    const actual = actualBreakdown.get(tid) ?? 0;
    if (actual !== expected) {
      mismatches.push(`${tid}: expected=${expected} actual=${actual}`);
    }
  }
  // 想定外 tenant も検出
  for (const [tid, actual] of actualBreakdown) {
    if (!expectedBreakdown.has(tid)) {
      mismatches.push(`${tid}: unexpected tenant, actual=${actual}`);
    }
  }
  if (mismatches.length > 0) {
    return { ok: false, reason: `tenant breakdown mismatch: ${mismatches.join("; ")}` };
  }
  return { ok: true };
}

/**
 * expected_count 完全一致ガード。
 * Codex 指摘反映: 本番 apply 時に対象件数が想定と完全一致しなければ fail させる。
 */
export function validateExpectedCount(
  actual: number,
  expected: number | undefined
): { ok: boolean; reason?: string } {
  if (expected === undefined) return { ok: true };
  if (actual !== expected) {
    return {
      ok: false,
      reason: `expected_count=${expected} だが実際の対象件数は ${actual} 件 (完全一致しないため中断)`,
    };
  }
  return { ok: true };
}

/**
 * 読み戻し検証: 書き込んだ synthetic session が期待値と完全一致するかチェック。
 */
export function validateReadback(
  expected: SyntheticSessionData,
  actual: SessionInfo & {
    sessionToken?: string;
    deadlineAt?: string;
    pauseStartedAt?: string | null;
    sessionVideoCompleted?: boolean;
    longestPauseSec?: number;
  }
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const fieldsToCheck: Array<keyof SyntheticSessionData> = [
    "userId",
    "lessonId",
    "courseId",
    "videoId",
    "sessionToken",
    "status",
    "entryAt",
    "exitAt",
    "exitReason",
    "deadlineAt",
    "pauseStartedAt",
    "longestPauseSec",
    "sessionVideoCompleted",
    "quizAttemptId",
    "isSynthetic",
  ];
  for (const field of fieldsToCheck) {
    const expectedVal = expected[field];
    const actualVal = (actual as unknown as Record<string, unknown>)[field];
    if (expectedVal !== actualVal) {
      mismatches.push(`${field}: expected=${JSON.stringify(expectedVal)} actual=${JSON.stringify(actualVal)}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ============================================================
// CLI 引数パース
// ============================================================

const KNOWN_FLAGS = [
  "--mode=",
  "--execute",
  "--tenant-id=",
  "--user-id=",
  "--user-email=",
  "--max-targets=",
  "--expected-count=",
  "--expected-count-tenant=",
  "--no-backup",
];

export type BackfillMode = "create-missing" | "update-existing";

const isMainEntry = import.meta.url === `file://${process.argv[1]}`;

if (isMainEntry) {
  void runCli();
}

interface ParsedArgs {
  mode: BackfillMode;
  execute: boolean;
  tenantId?: string;
  userId?: string;
  userEmail?: string;
  noBackup: boolean;
  maxTargets: number;
  expectedCount?: number;
  expectedCountTenant?: Map<string, number>;
}

function getFlagValue(args: string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.split("=")[1];
}

export function parseArgs(args: string[]): ParsedArgs {
  const unknownArgs = args.filter(
    (a) => !KNOWN_FLAGS.some((k) => a === k || a.startsWith(k))
  );
  if (unknownArgs.length > 0) {
    throw new Error(
      `未知のフラグ: ${unknownArgs.join(", ")}\n  既知のフラグ: ${KNOWN_FLAGS.join(" / ")}`
    );
  }

  const rawMode = getFlagValue(args, "--mode=");
  let mode: BackfillMode = "create-missing";
  if (rawMode !== undefined) {
    if (rawMode !== "create-missing" && rawMode !== "update-existing") {
      throw new Error(
        `--mode は "create-missing" | "update-existing" のいずれか: 受け取った値="${rawMode}"`
      );
    }
    mode = rawMode;
  }

  const execute = args.includes("--execute");
  const tenantId = getFlagValue(args, "--tenant-id=");
  const userId = getFlagValue(args, "--user-id=");
  const userEmail = getFlagValue(args, "--user-email=")?.trim().toLowerCase();
  const noBackup = args.includes("--no-backup");

  const rawMaxTargets = getFlagValue(args, "--max-targets=");
  const maxTargets = rawMaxTargets !== undefined ? Number(rawMaxTargets) : 100;
  if (!Number.isFinite(maxTargets) || maxTargets < 1) {
    throw new Error(
      `--max-targets は 1 以上の数値が必要: 受け取った値="${rawMaxTargets}"`
    );
  }

  const rawExpectedCount = getFlagValue(args, "--expected-count=");
  const expectedCount =
    rawExpectedCount !== undefined ? Number(rawExpectedCount) : undefined;
  if (
    expectedCount !== undefined &&
    (!Number.isFinite(expectedCount) ||
      !Number.isInteger(expectedCount) ||
      expectedCount < 0)
  ) {
    throw new Error(
      `--expected-count は 0 以上の整数が必要: 受け取った値="${rawExpectedCount}"`
    );
  }

  if (userId && userEmail) {
    throw new Error("--user-id と --user-email は同時指定できません");
  }

  // tenant 別 expected count (Codex finding #1 反映): --expected-count-tenant=tid1:N1,tid2:N2
  const rawTenantBreakdown = getFlagValue(args, "--expected-count-tenant=");
  let expectedCountTenant: Map<string, number> | undefined;
  if (rawTenantBreakdown !== undefined) {
    expectedCountTenant = parseExpectedCountTenant(rawTenantBreakdown);
  }

  return {
    mode,
    execute,
    tenantId,
    userId,
    userEmail,
    noBackup,
    maxTargets,
    expectedCount,
    expectedCountTenant,
  };
}

/** `tid1:N1,tid2:N2` 形式の文字列を Map に変換 (Phase 3 follow-up #4)。 */
export function parseExpectedCountTenant(raw: string): Map<string, number> {
  const result = new Map<string, number>();
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [tid, countStr] = entry.split(":");
    if (!tid || countStr === undefined) {
      throw new Error(
        `--expected-count-tenant の形式が不正 (期待: "tid1:N1,tid2:N2"): "${entry}"`
      );
    }
    const count = Number(countStr);
    if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
      throw new Error(
        `--expected-count-tenant の count が不正 (0 以上の整数が必要): "${entry}"`
      );
    }
    if (result.has(tid)) {
      throw new Error(`--expected-count-tenant に重複した tenant id: "${tid}"`);
    }
    result.set(tid, count);
  }
  return result;
}

// ============================================================
// メインフロー
// ============================================================

async function runCli(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `[FATAL] ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  // Firebase 初期化
  // GOOGLE_APPLICATION_CREDENTIALS には以下のいずれかが入り得る:
  //   1. type=service_account の JSON (ローカル開発時のサービスアカウントキー) → cert() で初期化
  //   2. type=external_account の JSON (GitHub Actions WIF 経由) → applicationDefault() で初期化
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
      `[FATAL] Firebase初期化失敗: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  const db = getFirestore();
  try {
    await runMain(db, parsed);
  } catch (err) {
    // runMain 内部からの予期せぬエラーを raw stack trace でなく [FATAL] で報告
    console.error(
      `[FATAL] 予期しないエラー: ${err instanceof Error ? (err.stack ?? err.message) : err}`
    );
    process.exit(1);
  }
}

export interface BackfillTarget {
  tenantId: string;
  attempt: AttemptInfo;
  lessonId: string;
  courseId: string;
  videoId: string;
  relatedSessions: SessionInfo[];
}

export interface AuditOnlyEntry {
  tenantId: string;
  attempt: AttemptInfo;
  relatedSessions: SessionInfo[];
  reason: string;
}

/**
 * Firestore doc.data() の戻り値から SessionInfo に共通フィールドを抽出する。
 * findBackfillTargets の relatedSessions マッピングと applyBackfill の readback マッピングで共有。
 */
function mapDataToSessionInfo(id: string, sd: Record<string, unknown>): SessionInfo {
  return {
    id,
    userId: sd.userId as string,
    lessonId: sd.lessonId as string,
    courseId: sd.courseId as string,
    videoId: sd.videoId as string,
    status: sd.status as string,
    entryAt: sd.entryAt as string,
    exitAt: (sd.exitAt as string | null | undefined) ?? null,
    exitReason: (sd.exitReason as string | null | undefined) ?? null,
    quizAttemptId: (sd.quizAttemptId as string | null | undefined) ?? null,
    isSynthetic: sd.isSynthetic as boolean | undefined,
  };
}

export async function runMain(
  db: Firestore,
  parsed: ParsedArgs
): Promise<void> {
  if (parsed.mode === "update-existing") {
    return runMainUpdateExisting(db, parsed);
  }
  console.log("=== #533 Phase 2: 合成 session 遡及作成 (create-missing モード) ===");
  console.log(
    `モード: ${parsed.execute ? "EXECUTE (実書き込み)" : "DRY-RUN (検出のみ)"}`
  );
  console.log(
    `スコープ: tenant=${parsed.tenantId ?? "ALL"} userId=${parsed.userId ?? "-"} userEmail=${parsed.userEmail ?? "-"}`
  );
  console.log(`最大対象件数: ${parsed.maxTargets}`);
  console.log(
    `expected_count: ${parsed.expectedCount ?? "(指定なし)"}${parsed.execute && parsed.expectedCount === undefined ? "  ⚠️  本番 apply では --expected-count 推奨" : ""}`
  );
  console.log(`バックアップ: ${parsed.noBackup ? "無効" : "有効"}\n`);

  // ユーザー解決 (--user-email 指定時)
  let scopedUserId = parsed.userId;
  let scopedTenantId = parsed.tenantId;
  if (parsed.userEmail) {
    const resolved = await resolveUserIdFromEmail(
      db,
      parsed.userEmail,
      scopedTenantId
    );
    if (!resolved) {
      console.error(`[FATAL] ユーザーが見つかりません: ${parsed.userEmail}`);
      process.exit(1);
    }
    scopedUserId = resolved.userId;
    scopedTenantId = resolved.tenantId;
    console.log(
      `ユーザー解決: ${parsed.userEmail} → tenantId=${scopedTenantId} userId=${scopedUserId}\n`
    );
  }

  // 対象テナント一覧
  const tenantsSnap = await db.collection("tenants").get();
  if (tenantsSnap.empty) {
    console.error(
      "[FATAL] tenants コレクションが空です。権限/プロジェクトID 確認してください。"
    );
    process.exit(1);
  }
  if (scopedTenantId) {
    const exists = tenantsSnap.docs.some((d) => d.id === scopedTenantId);
    if (!exists) {
      console.error(`[FATAL] tenant が見つかりません: ${scopedTenantId}`);
      process.exit(1);
    }
  }
  const tenantIds = scopedTenantId
    ? [scopedTenantId]
    : tenantsSnap.docs.map((d) => d.id);

  // 抽出
  const { targets, auditOnly } = await findBackfillTargets(
    db,
    tenantIds,
    scopedUserId
  );

  // tenant 名 + user_email 解決 (本番運用時の人間判読性向上、Phase 2 後送り対応)
  // backfill 件数が想定と divergent な時にテナント名と user_email で内訳特定する用途。
  // findBackfillTargets には触らず、本ループのみで cache 化して resolve する。
  const tenantNameCache = new Map<string, string>();
  const userEmailCache = new Map<string, string>(); // key: tid:uid
  async function resolveTenantName(tid: string): Promise<string> {
    if (tenantNameCache.has(tid)) return tenantNameCache.get(tid)!;
    const td = await db.collection("tenants").doc(tid).get();
    const name = (td.data()?.name as string | undefined) ?? tid;
    tenantNameCache.set(tid, name);
    return name;
  }
  async function resolveUserEmail(tid: string, uid: string): Promise<string> {
    const key = `${tid}:${uid}`;
    if (userEmailCache.has(key)) return userEmailCache.get(key)!;
    const ud = await db.collection(`tenants/${tid}/users`).doc(uid).get();
    const email = (ud.data()?.email as string | undefined) ?? "";
    userEmailCache.set(key, email);
    return email;
  }

  console.log("=== 抽出結果 ===");
  console.log(`backfill 対象: ${targets.length} 件`);
  console.log(`audit_only (apply 対象外): ${auditOnly.length} 件`);

  // tenant 単位の内訳表示 (Phase 2 後送り: 想定外スコープ時の即座把握用)
  if (targets.length > 0) {
    const tenantBreakdown = new Map<string, number>();
    for (const t of targets) {
      tenantBreakdown.set(t.tenantId, (tenantBreakdown.get(t.tenantId) ?? 0) + 1);
    }
    console.log("\n=== backfill 対象 tenant 内訳 ===");
    for (const [tid, count] of tenantBreakdown) {
      const name = await resolveTenantName(tid);
      console.log(`  tenant=${tid} (${name}): ${count} 件`);
    }
  }

  // expected_count 完全一致ガード (Codex M2)
  const validation = validateExpectedCount(targets.length, parsed.expectedCount);
  if (!validation.ok) {
    console.error(`[FATAL] ${validation.reason}`);
    process.exit(1);
  }

  if (auditOnly.length > 0) {
    console.log("\n=== audit_only サンプル (最大 10 件) ===");
    for (const e of auditOnly.slice(0, 10)) {
      console.log(
        `  tenant=${e.tenantId} attempt=${e.attempt.id} user=${e.attempt.userId} reason=${e.reason} relatedSessions=${e.relatedSessions.length}`
      );
    }
  }

  if (targets.length === 0) {
    console.log("\nbackfill 対象なし");
    return;
  }

  // 件数アサーション (max_targets)
  if (targets.length > parsed.maxTargets) {
    console.error(
      `[FATAL] backfill 対象が ${parsed.maxTargets} 件を超えています (${targets.length} 件)`
    );
    console.error(
      "  --max-targets で上限を上げるか、--tenant-id/--user-id でスコープ絞り込みしてください"
    );
    process.exit(1);
  }

  // backup (apply 前に出力)
  if (!parsed.noBackup) {
    const backupPath = `backfill-synthetic-backup-${Date.now()}.json`;
    const backup = {
      scriptVersion: "1.0.0",
      commitSha: process.env.GITHUB_SHA ?? "(local)",
      githubRunId: process.env.GITHUB_RUN_ID ?? "(local)",
      githubActor: process.env.GITHUB_ACTOR ?? "(local)",
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "(unknown)",
      mode: parsed.execute ? "execute" : "dry-run",
      generatedAt: new Date().toISOString(),
      targets: await Promise.all(targets.map(async (t) => ({
        tenantId: t.tenantId,
        tenantName: await resolveTenantName(t.tenantId),
        userEmail: await resolveUserEmail(t.tenantId, t.attempt.userId),
        attempt: t.attempt,
        lessonId: t.lessonId,
        courseId: t.courseId,
        videoId: t.videoId,
        relatedSessions: t.relatedSessions, // pre-existing snapshot (Codex M4)
        plannedSession: buildSyntheticSessionData(
          t.attempt,
          t.lessonId,
          t.courseId,
          t.videoId
        ),
      }))),
      auditOnly: await Promise.all(auditOnly.map(async (a) => ({
        ...a,
        tenantName: await resolveTenantName(a.tenantId),
        userEmail: await resolveUserEmail(a.tenantId, a.attempt.userId),
      }))),
    };
    try {
      writeFileSync(backupPath, JSON.stringify(backup, null, 2));
      console.log(`バックアップ: ${backupPath}`);
    } catch (err) {
      // backup 書き込み失敗 → apply 中止 (raw stack trace でなく [FATAL] を出して exit)
      console.error(
        `[FATAL] backup 書き込み失敗、apply 中止: ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }
  } else if (parsed.execute) {
    console.error(
      "[FATAL] --execute と --no-backup の組み合わせは禁止 (Codex AC2.9)"
    );
    process.exit(1);
  }

  // backfill 対象サンプル
  console.log("\n=== backfill 対象サンプル (最大 10 件) ===");
  for (const t of targets.slice(0, 10)) {
    console.log(
      `  tenant=${t.tenantId} attempt=${t.attempt.id} user=${t.attempt.userId} lesson=${t.lessonId} startedAt=${t.attempt.startedAt} submittedAt=${t.attempt.submittedAt}`
    );
  }

  if (!parsed.execute) {
    console.log("\nDRY-RUN: --execute で実行");
    return;
  }

  // 実行
  console.log("\n=== 実行 ===");
  const result = await applyBackfill(db, targets);
  console.log("\n=== 完了 ===");
  console.log(`  created: ${result.created}`);
  console.log(
    `  skipped: ${result.skipped} (既存 synthetic doc / 並行作成)`
  );
  console.log(`  failed:  ${result.failed}`);
  console.log(`  readback verified: ${result.readbackVerified}`);
  if (result.readbackFailed > 0) {
    console.log(
      `  ⚠️ readback failed: ${result.readbackFailed} (synthetic doc に期待値との差分あり、backup と diff 確認推奨)`
    );
  }

  // readbackFailed も非 0 exit にする (apply 成功扱い → オペレーター見落とし防止)
  if (result.failed > 0 || result.readbackFailed > 0) {
    process.exit(1);
  }
}

// ============================================================
// Firestore 連携
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

export async function findBackfillTargets(
  db: Firestore,
  tenantIds: string[],
  scopedUserId?: string
): Promise<{ targets: BackfillTarget[]; auditOnly: AuditOnlyEntry[] }> {
  const targets: BackfillTarget[] = [];
  const auditOnly: AuditOnlyEntry[] = [];
  let skippedInvalid = 0;

  for (const tid of tenantIds) {
    // status=submitted + isPassed=true で絞り込み (Codex 反映済 status 値)
    let attemptsQuery = db
      .collection(`tenants/${tid}/quiz_attempts`)
      .where("status", "==", "submitted")
      .where("isPassed", "==", true);
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
        isPassed: data.isPassed ?? null,
        startedAt: data.startedAt ?? null,
        submittedAt: data.submittedAt ?? null,
        quizId: data.quizId,
        userId: data.userId,
        attemptNumber: data.attemptNumber,
        score: data.score ?? null,
      };

      // タイムスタンプ欠落チェック (build 時の早期エラー回避)
      if (!attempt.startedAt || !attempt.submittedAt) {
        console.warn(
          `[WARN] timestamp 欠落: tenant=${tid} attempt=${attempt.id} startedAt=${attempt.startedAt} submittedAt=${attempt.submittedAt} → skip`
        );
        skippedInvalid++;
        continue;
      }

      // quiz から lessonId / courseId / videoId を解決
      const quizDoc = await db
        .collection(`tenants/${tid}/quizzes`)
        .doc(attempt.quizId)
        .get();
      if (!quizDoc.exists) {
        console.warn(
          `[WARN] quiz 削除済み: tenant=${tid} attempt=${attempt.id} quizId=${attempt.quizId} → skip`
        );
        skippedInvalid++;
        continue;
      }
      const quizData = quizDoc.data()!;
      const lessonId = quizData.lessonId as string;
      const courseId = quizData.courseId as string;

      // lesson 存在確認 (削除済みなら skip)
      const lessonDoc = await db
        .collection(`tenants/${tid}/lessons`)
        .doc(lessonId)
        .get();
      if (!lessonDoc.exists) {
        console.warn(
          `[WARN] lesson 削除済み: tenant=${tid} attempt=${attempt.id} lessonId=${lessonId} → skip`
        );
        skippedInvalid++;
        continue;
      }

      // videoId 解決: Phase 1 helper (getVideoByLessonId, firestore.ts:900) と同じ
      // canonical な videos.lessonId where 検索を使う。lessons.videoId 直接読みは
      // Phase 1 と divergent するため不可 (一部 lesson に videoId field が無い場合に silent skip)。
      const videosSnap = await db
        .collection(`tenants/${tid}/videos`)
        .where("lessonId", "==", lessonId)
        .limit(1)
        .get();
      if (videosSnap.empty) {
        console.warn(
          `[WARN] video 未紐付け: tenant=${tid} attempt=${attempt.id} lessonId=${lessonId} → skip`
        );
        skippedInvalid++;
        continue;
      }
      const videoId = videosSnap.docs[0].id;

      // 関連 sessions 取得 (同 user + 同 lesson)
      const sessionsSnap = await db
        .collection(`tenants/${tid}/lesson_sessions`)
        .where("userId", "==", attempt.userId)
        .where("lessonId", "==", lessonId)
        .get();

      const relatedSessions: SessionInfo[] = sessionsSnap.docs.map((d) =>
        mapDataToSessionInfo(d.id, d.data())
      );

      const category = categorizeAttempt(attempt, relatedSessions);
      if (category === "backfill_target") {
        targets.push({
          tenantId: tid,
          attempt,
          lessonId,
          courseId,
          videoId,
          relatedSessions,
        });
      } else if (category === "audit_only") {
        const linked = relatedSessions.filter(
          (s) => s.quizAttemptId === attempt.id
        );
        auditOnly.push({
          tenantId: tid,
          attempt,
          relatedSessions,
          reason: `quizAttemptId 一致 session が ${linked.length} 件存在 (status: ${linked.map((s) => s.status).join("/")})`,
        });
      }
    }
  }

  if (skippedInvalid > 0) {
    console.warn(`\n[WARN] skipped (invalid data): ${skippedInvalid} 件`);
  }
  return { targets, auditOnly };
}

export interface ApplyResult {
  created: number;
  skipped: number;
  failed: number;
  readbackVerified: number;
  readbackFailed: number;
}

export async function applyBackfill(
  db: Firestore,
  targets: BackfillTarget[]
): Promise<ApplyResult> {
  const result: ApplyResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    readbackVerified: 0,
    readbackFailed: 0,
  };

  for (const t of targets) {
    const docId = `synthetic_${t.attempt.id}`;
    const ref = db
      .collection(`tenants/${t.tenantId}/lesson_sessions`)
      .doc(docId);
    const planned = buildSyntheticSessionData(
      t.attempt,
      t.lessonId,
      t.courseId,
      t.videoId
    );
    // Phase 1 createLessonSessionWithId と同じ Date オブジェクトを渡し Timestamp 型で保存させる
    // (ISO string 渡しだと同コレクション内で createdAt の型が混在し orderBy 結果が divergent)。
    const now = new Date();

    // 状態復旧 (apply) を最優先で独立 try/catch (rules/error-handling.md §1)
    try {
      const created = await db.runTransaction(async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists) return false;
        // sanitize: undefined フィールドは Firestore に渡さない (rules/production-data-safety.md §1)
        const payload = sanitizeForWrite(buildWritePayload(planned, now));
        tx.create(ref, payload);
        return true;
      });
      if (created) result.created++;
      else result.skipped++;
    } catch (err) {
      // tx.create が race で ALREADY_EXISTS をスローした場合は skip 扱い。
      // gRPC status code = 6, Firebase Firestore Web SDK の文字列表現は 'already-exists' (lowercase, hyphen)、
      // admin SDK の文字列表現は 'ALREADY_EXISTS' (uppercase, underscore)。両形式を許容する。
      // 通常 runTransaction は ABORTED を retry するが、permanent error の場合の retry 後 catch で到達。
      const errCode = (err as { code?: number | string } | null | undefined)?.code;
      if (
        errCode === 6 ||
        errCode === "ALREADY_EXISTS" ||
        errCode === "already-exists"
      ) {
        result.skipped++;
        continue;
      }
      result.failed++;
      console.error(
        `  失敗: tenant=${t.tenantId} attempt=${t.attempt.id}: ${err instanceof Error ? err.message : err}`
      );
      continue;
    }

    // 読み戻し検証 (独立 try/catch)。readbackFailed > 0 は最終的に exit 1 で扱われる
    // (rules/error-handling.md §1: 状態復旧と検証を独立 try/catch で分離)。
    try {
      const readback = await ref.get();
      if (!readback.exists) {
        result.readbackFailed++;
        console.error(
          `  readback 失敗: tenant=${t.tenantId} attempt=${t.attempt.id} (doc not found)`
        );
        continue;
      }
      const data = readback.data()!;
      // SessionInfo の共通部分 + readback で validate する追加フィールド (sessionToken /
      // deadlineAt / pauseStartedAt / sessionVideoCompleted / longestPauseSec) を merge する。
      // pauseStartedAt は `?? null` で undefined を丸めるため field 欠落 (本来 null で書かれるべき) は
      // ここでは検出できない。書き込み payload は常に pauseStartedAt: null を含むため実害は低い
      // (sanitize 戦略が undefined 除去になっても null は保持される)。
      const actual = {
        ...mapDataToSessionInfo(readback.id, data),
        sessionToken: data.sessionToken as string,
        deadlineAt: data.deadlineAt as string,
        pauseStartedAt: (data.pauseStartedAt as string | null | undefined) ?? null,
        sessionVideoCompleted: data.sessionVideoCompleted as boolean | undefined,
        longestPauseSec: data.longestPauseSec as number | undefined,
      };
      const check = validateReadback(planned, actual);
      if (check.ok) {
        result.readbackVerified++;
      } else {
        result.readbackFailed++;
        console.error(
          `  readback 不一致: tenant=${t.tenantId} attempt=${t.attempt.id} mismatches=${check.mismatches.join(", ")}`
        );
      }
    } catch (err) {
      result.readbackFailed++;
      console.error(
        `  readback 例外: tenant=${t.tenantId} attempt=${t.attempt.id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  return result;
}

/**
 * Firestore 書き込み用に undefined フィールドを除去 (rules/production-data-safety.md §1)。
 */
export function sanitizeForWrite<T extends Record<string, unknown>>(
  obj: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

// ============================================================
// Phase 3 follow-up #4 (D 案): update-existing モード実装
// ============================================================

export interface UpdateTarget {
  tenantId: string;
  attempt: AttemptInfo;
  syntheticDocId: string;
  videoDurationSec: number;
  oldExitAt: string;
  newExitAt: string;
  existingDocSnapshot: Record<string, unknown>;
}

export interface UpdateApplyResult {
  updated: number;
  skipped: number;
  failed: number;
  readbackVerified: number;
  readbackFailed: number;
}

interface SkipReasonEntry {
  tenantId: string;
  attemptId: string;
  reason: BackfillUpdateCategory;
}

export async function findUpdateTargets(
  db: Firestore,
  tenantIds: string[],
  scopedUserId?: string
): Promise<{ targets: UpdateTarget[]; skipped: SkipReasonEntry[] }> {
  const targets: UpdateTarget[] = [];
  const skipped: SkipReasonEntry[] = [];

  for (const tid of tenantIds) {
    let attemptsQuery = db
      .collection(`tenants/${tid}/quiz_attempts`)
      .where("status", "==", "submitted")
      .where("isPassed", "==", true);
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
        isPassed: data.isPassed ?? null,
        startedAt: data.startedAt ?? null,
        submittedAt: data.submittedAt ?? null,
        quizId: data.quizId,
        userId: data.userId,
        attemptNumber: data.attemptNumber,
        score: data.score ?? null,
      };

      // synthetic doc を直接取得
      const syntheticDocId = `synthetic_${attempt.id}`;
      const synSnap = await db
        .collection(`tenants/${tid}/lesson_sessions`)
        .doc(syntheticDocId)
        .get();
      if (!synSnap.exists) {
        skipped.push({ tenantId: tid, attemptId: attempt.id, reason: "skip_no_synthetic" });
        continue;
      }
      const sd = synSnap.data()!;
      const synthetic: SessionInfo & { editedAt?: string; original?: unknown } = {
        ...mapDataToSessionInfo(synSnap.id, sd),
        editedAt: sd.editedAt as string | undefined,
        original: sd.original,
      };

      const category = categorizeAttemptForUpdate(attempt, [synthetic]);
      if (category !== "update_target") {
        skipped.push({ tenantId: tid, attemptId: attempt.id, reason: category });
        continue;
      }

      // quiz → lessonId / video 解決
      const quizDoc = await db
        .collection(`tenants/${tid}/quizzes`)
        .doc(attempt.quizId)
        .get();
      if (!quizDoc.exists) {
        skipped.push({ tenantId: tid, attemptId: attempt.id, reason: "skip_invalid_attempt" });
        continue;
      }
      const lessonId = quizDoc.data()!.lessonId as string;

      const videosSnap = await db
        .collection(`tenants/${tid}/videos`)
        .where("lessonId", "==", lessonId)
        .limit(1)
        .get();
      if (videosSnap.empty) {
        skipped.push({ tenantId: tid, attemptId: attempt.id, reason: "skip_invalid_attempt" });
        continue;
      }
      const videoData = videosSnap.docs[0].data();
      const videoDurationSec = videoData.durationSec as number;
      if (!Number.isFinite(videoDurationSec) || videoDurationSec <= 0) {
        console.warn(
          `[WARN] invalid videoDurationSec: tenant=${tid} attempt=${attempt.id} videoDurationSec=${videoDurationSec} → skip`
        );
        skipped.push({ tenantId: tid, attemptId: attempt.id, reason: "skip_invalid_attempt" });
        continue;
      }

      let newExitAt: string;
      try {
        newExitAt = buildUpdatedExitAt(attempt, videoDurationSec);
      } catch (err) {
        console.warn(
          `[WARN] buildUpdatedExitAt failed: tenant=${tid} attempt=${attempt.id} err=${err instanceof Error ? err.message : err}`
        );
        skipped.push({ tenantId: tid, attemptId: attempt.id, reason: "skip_invalid_attempt" });
        continue;
      }

      targets.push({
        tenantId: tid,
        attempt,
        syntheticDocId,
        videoDurationSec,
        oldExitAt: synthetic.exitAt!,
        newExitAt,
        existingDocSnapshot: sd,
      });
    }
  }

  return { targets, skipped };
}

export async function applyBackfillUpdate(
  db: Firestore,
  targets: UpdateTarget[]
): Promise<UpdateApplyResult> {
  const result: UpdateApplyResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
    readbackVerified: 0,
    readbackFailed: 0,
  };

  for (const t of targets) {
    const ref = db.collection(`tenants/${t.tenantId}/lesson_sessions`).doc(t.syntheticDocId);

    try {
      const updated = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const sd = snap.data()!;

        // transaction 内再検証 (Codex 指摘 #4 + finding #3 反映)
        if (sd.isSynthetic !== true) return false;
        if (sd.entryAt !== t.attempt.startedAt) return false;
        if (sd.exitAt !== t.attempt.submittedAt) return false;
        if (sd.original !== undefined && sd.original !== null) return false;
        if (sd.editedAt !== undefined && sd.editedAt !== null) return false;
        // Codex finding #3 反映: より厳格な再検証
        if (sd.quizAttemptId !== t.attempt.id) return false;
        if (sd.userId !== t.attempt.userId) return false;
        if (sd.status !== "completed") return false;
        if (sd.exitReason !== "quiz_submitted") return false;

        tx.update(ref, {
          exitAt: t.newExitAt,
          updatedAt: new Date(),
        });
        return true;
      });
      if (updated) result.updated++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      console.error(
        `  失敗: tenant=${t.tenantId} attempt=${t.attempt.id}: ${err instanceof Error ? err.message : err}`
      );
      continue;
    }

    // readback 検証 (独立 try/catch、rules/error-handling.md §1)
    try {
      const readback = await ref.get();
      if (!readback.exists) {
        result.readbackFailed++;
        continue;
      }
      const data = readback.data()!;
      const mismatches: string[] = [];
      if (data.exitAt !== t.newExitAt) mismatches.push(`exitAt: expected=${t.newExitAt} actual=${data.exitAt}`);
      if (data.entryAt !== t.attempt.startedAt) mismatches.push(`entryAt不変: expected=${t.attempt.startedAt} actual=${data.entryAt}`);
      if (mismatches.length > 0) {
        result.readbackFailed++;
        console.error(
          `  readback 不一致: tenant=${t.tenantId} attempt=${t.attempt.id} ${mismatches.join(", ")}`
        );
      } else {
        result.readbackVerified++;
      }
    } catch (err) {
      result.readbackFailed++;
      console.error(
        `  readback 例外: tenant=${t.tenantId} attempt=${t.attempt.id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return result;
}

async function runMainUpdateExisting(
  db: Firestore,
  parsed: ParsedArgs
): Promise<void> {
  console.log("=== #533 Phase 3 follow-up #4: D 案 exitAt 上書き (update-existing モード) ===");
  console.log(
    `モード: ${parsed.execute ? "EXECUTE (実書き込み)" : "DRY-RUN (検出のみ)"}`
  );
  console.log(
    `スコープ: tenant=${parsed.tenantId ?? "ALL"} userId=${parsed.userId ?? "-"} userEmail=${parsed.userEmail ?? "-"}`
  );
  console.log(`最大対象件数: ${parsed.maxTargets}`);
  console.log(
    `expected_count: ${parsed.expectedCount ?? "(指定なし)"}${parsed.execute && parsed.expectedCount === undefined ? "  ⚠️  本番 apply では --expected-count 推奨" : ""}`
  );
  console.log(`バックアップ: ${parsed.noBackup ? "無効" : "有効"}\n`);

  // ユーザー解決
  let scopedUserId = parsed.userId;
  let scopedTenantId = parsed.tenantId;
  if (parsed.userEmail) {
    const resolved = await resolveUserIdFromEmail(db, parsed.userEmail, scopedTenantId);
    if (!resolved) {
      console.error(`[FATAL] ユーザーが見つかりません: ${parsed.userEmail}`);
      process.exit(1);
    }
    scopedUserId = resolved.userId;
    scopedTenantId = resolved.tenantId;
  }

  const tenantsSnap = await db.collection("tenants").get();
  if (tenantsSnap.empty) {
    console.error("[FATAL] tenants コレクションが空です");
    process.exit(1);
  }
  const tenantIds = scopedTenantId
    ? [scopedTenantId]
    : tenantsSnap.docs.map((d) => d.id);

  const { targets, skipped } = await findUpdateTargets(db, tenantIds, scopedUserId);

  console.log("=== 抽出結果 ===");
  console.log(`update 対象: ${targets.length} 件`);
  console.log(`skip: ${skipped.length} 件`);

  // skip 理由内訳
  if (skipped.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const s of skipped) {
      reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1);
    }
    console.log("\n=== skip 理由内訳 ===");
    for (const [reason, count] of reasonCounts) {
      console.log(`  ${reason}: ${count} 件`);
    }
  }

  // tenant 別内訳
  const tenantBreakdown = new Map<string, number>();
  for (const t of targets) {
    tenantBreakdown.set(t.tenantId, (tenantBreakdown.get(t.tenantId) ?? 0) + 1);
  }
  if (targets.length > 0) {
    console.log("\n=== update 対象 tenant 内訳 ===");
    for (const [tid, count] of tenantBreakdown) {
      console.log(`  tenant=${tid}: ${count} 件`);
    }
  }

  // expected_count 完全一致ガード
  const validation = validateExpectedCount(targets.length, parsed.expectedCount);
  if (!validation.ok) {
    console.error(`[FATAL] ${validation.reason}`);
    process.exit(1);
  }

  // tenant 別 expected count 検証 (Codex finding #1 反映)
  if (parsed.expectedCountTenant !== undefined) {
    const tenantValidation = validateTenantBreakdown(
      tenantBreakdown,
      parsed.expectedCountTenant,
    );
    if (!tenantValidation.ok) {
      console.error(`[FATAL] ${tenantValidation.reason}`);
      process.exit(1);
    }
    console.log("\ntenant 別件数: 期待値と完全一致 ✓");
  }

  if (targets.length === 0) {
    console.log("\nupdate 対象なし");
    return;
  }

  if (targets.length > parsed.maxTargets) {
    console.error(
      `[FATAL] update 対象が ${parsed.maxTargets} 件を超えています (${targets.length} 件)`
    );
    process.exit(1);
  }

  // backup
  if (!parsed.noBackup) {
    const backupPath = `backfill-synthetic-backup-${Date.now()}.json`;
    const backup = {
      scriptVersion: "2.0.0",
      mode: parsed.mode,
      commitSha: process.env.GITHUB_SHA ?? "(local)",
      githubRunId: process.env.GITHUB_RUN_ID ?? "(local)",
      githubActor: process.env.GITHUB_ACTOR ?? "(local)",
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "(unknown)",
      executeMode: parsed.execute ? "execute" : "dry-run",
      generatedAt: new Date().toISOString(),
      // Codex 指摘 #4: backup に旧 exitAt + 完全 doc snapshot + attempt 全体
      targets: targets.map((t) => ({
        tenantId: t.tenantId,
        attempt: t.attempt,
        syntheticDocId: t.syntheticDocId,
        videoDurationSec: t.videoDurationSec,
        oldExitAt: t.oldExitAt,
        newExitAt: t.newExitAt,
        existingDocSnapshot: t.existingDocSnapshot,
      })),
      skipped,
    };
    try {
      writeFileSync(backupPath, JSON.stringify(backup, null, 2));
      console.log(`\nバックアップ: ${backupPath}`);
    } catch (err) {
      console.error(`[FATAL] backup 書き込み失敗、apply 中止: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else if (parsed.execute) {
    console.error("[FATAL] --execute と --no-backup の組み合わせは禁止");
    process.exit(1);
  }

  // サンプル
  console.log("\n=== update 対象サンプル (最大 10 件) ===");
  for (const t of targets.slice(0, 10)) {
    console.log(
      `  tenant=${t.tenantId} attempt=${t.attempt.id} oldExitAt=${t.oldExitAt} → newExitAt=${t.newExitAt} (videoDuration=${t.videoDurationSec}s)`
    );
  }

  if (!parsed.execute) {
    console.log("\nDRY-RUN: --execute で実行");
    return;
  }

  // 実行
  console.log("\n=== 実行 ===");
  const result = await applyBackfillUpdate(db, targets);
  console.log("\n=== 完了 ===");
  console.log(`  updated: ${result.updated}`);
  console.log(`  skipped: ${result.skipped} (transaction 内再検証で除外)`);
  console.log(`  failed:  ${result.failed}`);
  console.log(`  readback verified: ${result.readbackVerified}`);
  if (result.readbackFailed > 0) {
    console.log(`  ⚠️ readback failed: ${result.readbackFailed}`);
  }

  // Codex finding #2 反映: destructive write の apply は部分成功でも non-zero exit。
  // expected_count を通過してから 1 件 skip された場合は concurrent edit や data drift の兆候。
  if (result.failed > 0 || result.readbackFailed > 0) {
    console.error(
      `[FATAL] backfill 部分失敗: failed=${result.failed} readbackFailed=${result.readbackFailed}`
    );
    process.exit(1);
  }
  if (result.skipped > 0) {
    console.error(
      `[FATAL] transaction 内再検証で ${result.skipped} 件 skip (concurrent edit / data drift の可能性、要調査)`
    );
    process.exit(1);
  }
  if (result.updated !== targets.length || result.readbackVerified !== result.updated) {
    console.error(
      `[FATAL] 部分成功: targets=${targets.length} updated=${result.updated} readbackVerified=${result.readbackVerified}`
    );
    process.exit(1);
  }
  console.log("\n✓ 全件 update + readback verified");
}
