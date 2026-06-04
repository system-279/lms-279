/**
 * 進捗レポート定期自動配信 dry-run service module (Phase 4 α-7 A1)。
 *
 * 目的:
 *   - 既存 `scripts/progress-report-dry-run-cli.ts` の純粋ロジックを抽出
 *   - HTTP endpoint (Phase 4 α-7 C1) と CLI wrapper (Phase 4 α-7 A3) の両方から
 *     共通利用するための DI 化された service
 *
 * 完全 read-only:
 *   - Firestore write なし (storage は getDispatchSettings のみ参照)
 *   - Gmail send / PDF 実生成なし
 *   - test-send 経路は本 module に **存在しない** (PR #490 撤廃方針維持)
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク A1
 *   - PR #490 撤廃理由の解消: 同 impl-plan §「PR #490 撤廃理由の解消」
 *   - 旧 CLI: scripts/progress-report-dry-run-cli.ts (A3 で薄 wrapper 化)
 */

import type {
  DispatchSettings,
  ProgressDryRunResult,
  ProgressDryRunTenantSummary,
} from "@lms-279/shared-types";

import {
  validateAndDedupeCcEmails,
  validateSingleEmail,
} from "../cc-email-validator.js";
import { evaluateCompletionEligibility } from "../completion-eligibility.js";
import type { DispatchStorage } from "../dispatch-storage.js";
import type { TenantDataLoader } from "../tenant-data-loader.js";

// 型定義は `@lms-279/shared-types` に集約 (B タスクで移管完了)。
// ProgressDryRunResult / ProgressDryRunTenantSummary / ProgressDryRunSkipReason は
// FE / BE / CLI すべてが shared-types から import する。

// ============================================================
// 定数 (CLI と同じ、変更時は両方を同期)
// ============================================================

/** 1 通あたりの平均処理時間目安 (PDF 生成 1.5s + Gmail send 0.3s + Firestore write 0.2s) */
export const AVG_PER_USER_MS = 2000;
/** user 並列度 (run-progress-reports DEFAULT_USER_CONCURRENCY と一致) */
export const USER_CONCURRENCY = 8;
/** scale trigger threshold */
export const SCALE_TRIGGER_THRESHOLD = 300;
/** 推定 PDF サイズ範囲 (KB)。実測は cutover smoke で確認 */
export const PDF_SIZE_KB_RANGE = { min: 150, typical: 350, max: 1200 };

// ============================================================
// 依存性注入 interface
// ============================================================

/**
 * 警告 logger inject。CLI 経由では console.error、HTTP endpoint 経由では
 * 構造化ログ、test では noop を渡せる。
 */
export interface ProgressDryRunLogger {
  warnTenantDocNotFound(tenantId: string): void;
}

const NOOP_LOGGER: ProgressDryRunLogger = {
  warnTenantDocNotFound: () => {},
};

/**
 * console.error 出力する logger 実装 (CLI 経由デフォルト)。
 * メッセージ書式は旧 CLI と同一。
 */
export const CONSOLE_PROGRESS_DRY_RUN_LOGGER: ProgressDryRunLogger = {
  warnTenantDocNotFound: (tenantId) => {
    console.error(
      `[WARN] tenant_doc_not_found: tenants/${tenantId} doc が存在しません。subcollection 孤児の可能性があるため運用者の確認推奨。`,
    );
  },
};

/**
 * `runProgressReportDryRun` の入力。
 *
 * `storage` は `Pick<DispatchStorage, "getDispatchSettings">` で **明示的に
 * read-only API のみ** に絞る (Phase 4 α-7 AC-α7-06: read-only 保証の型レベル担保)。
 */
export interface RunProgressReportDryRunInput {
  storage: Pick<DispatchStorage, "getDispatchSettings">;
  loader: TenantDataLoader;
  /** test では fixed Date を inject、CLI / endpoint では `new Date()` */
  now?: Date;
  /** test / endpoint では noop or 構造化、CLI では `CONSOLE_PROGRESS_DRY_RUN_LOGGER` */
  logger?: ProgressDryRunLogger;
}

// ============================================================
// メイン dry-run ロジック
// ============================================================

/**
 * 進捗レポート定期配信の dry-run を実行し、対象人数 / 規模試算を返す。
 *
 * 旧 CLI の `runProgressReportDryRunCli` を DI 化した実装。
 * CLI 互換は A3 の薄 wrapper で維持する。
 */
export async function runProgressReportDryRun(
  input: RunProgressReportDryRunInput,
): Promise<ProgressDryRunResult> {
  const { storage, loader, now = new Date(), logger = NOOP_LOGGER } = input;

  // ① settings 読み取り
  // doc missing 許容: 初期化前 cutover リハーサル想定で「対象規模見積もり」だけは返す。
  // read/parse error は致命扱いし fail-fast にする (silent fallback は cutover 判断材料の
  // 整合性を壊すため、completion-notification-dry-run と同パターン)。
  const settings: DispatchSettings | null = await storage.getDispatchSettings();

  // ② tenants 走査
  const tenantIds = await loader.listAllTenantIds();
  const tenantsSummary: ProgressDryRunTenantSummary[] = [];
  let totalWouldSendCount = 0;
  let totalCcCount = 0;

  for (const tenantId of tenantIds) {
    // ③ active + progressReportEnabled チェック (AC-PR-04)
    const tenantInfo = await loader.getTenantInfo(tenantId);
    if (!tenantInfo) {
      // listAllTenantIds() は tenantId を返したが tenants/{tid} doc が不在。
      // subcollection 孤児やテナント cascade delete 未完了の可能性があり、
      // 後で同一 tenantId が再利用されたら誤配信に直結するため logger 経由で alert。
      logger.warnTenantDocNotFound(tenantId);
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "tenant_doc_not_found",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount: 0,
      });
      continue;
    }
    if (!tenantInfo.active) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "tenant_not_active",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount: 0,
      });
      continue;
    }
    if (!tenantInfo.progressReportEnabled) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "progress_report_disabled",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount: 0,
      });
      continue;
    }

    // ④ CC config 取得 (進捗レーンは CC null でも To 単独で送信、AC-PR-11 設定独立性)
    const ccConfig = await loader.getTenantCcConfig(tenantId);
    const ccDedup = validateAndDedupeCcEmails(
      ccConfig?.notificationCcEmails ?? [],
      ccConfig?.ownerEmail ?? null,
    );
    const ccCount = ccDedup.validCcEmails.length;

    // ⑤ 対象 user 列挙 (Plan A: student + 期限内 + 進捗 1% 以上、ADR-039 D-5)
    const dataView = loader.getTenantDataView(tenantId);
    const publishedCourses = await dataView.listPublishedCourses();
    if (publishedCourses.length === 0) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "no_published_courses",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount,
      });
      continue;
    }

    const users = await dataView.listProgressReportTargetUsers(now);
    // candidateCount は listProgressReportTargetUsers 戻り値全体を表す。
    // 送信不能要因 (invalid email / 100% 完了) は内訳カウンタで切り分け、運用者が
    // 「dry-run で見えない skip 規模」を取りこぼさないようにする。
    const candidateCount = users.length;
    let invalidEmailCount = 0;
    let completedCount = 0;
    let wouldSendCount = 0;

    for (const user of users) {
      // email validation (進捗レーンも完了通知レーンと同様、無効 email は送信不能)
      const emailV = validateSingleEmail(user.email);
      if (!emailV.ok) {
        invalidEmailCount += 1;
        continue;
      }

      // 100% 完了者は進捗レーン skip (AC-PR-02、完了通知レーンがカバー済)
      const progresses = await dataView.listCourseProgressForUser(user.id);
      const eligibility = evaluateCompletionEligibility(
        publishedCourses,
        progresses,
      );
      if (eligibility.eligible) {
        completedCount += 1;
        continue;
      }

      wouldSendCount += 1;
    }

    tenantsSummary.push({
      tenantId,
      skipped: false,
      usersScanned: users.length,
      candidateCount,
      invalidEmailCount,
      completedCount,
      wouldSendCount,
      ccCount,
    });

    totalWouldSendCount += wouldSendCount;
    totalCcCount += wouldSendCount * ccCount;
  }

  // ⑥ 推定処理時間 = (totalWouldSendCount / userConcurrency) * AVG_PER_USER_MS
  // 並列度 8 を超える user 数では Cloud Run timeout (280s) を意識した値になる
  const estimatedDurationMs =
    Math.ceil(totalWouldSendCount / USER_CONCURRENCY) * AVG_PER_USER_MS;

  return {
    lane: "progress",
    evaluatedAt: now.toISOString(),
    settingsLoaded: settings !== null,
    settingsSnapshot: settings
      ? {
          progressReportEnabled: settings.progressReport?.enabled ?? false,
          scheduleDaysOfWeek: settings.progressReport?.scheduleDaysOfWeek ?? [],
          scheduleHourJst: settings.progressReport?.scheduleHourJst ?? 0,
          signatureName: settings.signatureName,
        }
      : null,
    tenantsScanned: tenantIds.length,
    tenantsSummary,
    totalWouldSendCount,
    totalCcCount,
    estimatedDurationMs,
    estimatedPdfSizeKbRange: PDF_SIZE_KB_RANGE,
    scaleTriggerExceeded: totalWouldSendCount > SCALE_TRIGGER_THRESHOLD,
  };
}
