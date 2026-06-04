/**
 * 完了通知 dry-run service module (Phase 4 α-7 A2)。
 *
 * 目的:
 *   - 既存 `scripts/dispatch-dry-run-cli.ts` の純粋ロジックを抽出
 *   - HTTP endpoint (Phase 4 α-7 C1) と CLI wrapper (Phase 4 α-7 A3) の両方から
 *     共通利用するための DI 化された service
 *
 * 完全 read-only:
 *   - Firestore write なし (storage は getDispatchSettings + getCompletionNotification のみ)
 *   - Gmail send なし
 *   - test-send 経路は本 module に **存在しない** (PR #490 撤廃方針維持)
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク A2
 *   - PR #490 撤廃理由の解消: 同 impl-plan §「PR #490 撤廃理由の解消」
 *   - 旧 CLI: scripts/dispatch-dry-run-cli.ts (A3 で薄 wrapper 化)
 */

import type {
  DispatchSettings,
  CompletionDryRunResult,
  CompletionDryRunTarget,
  CompletionDryRunTenantSummary,
} from "@lms-279/shared-types";

import { validateAndDedupeCcEmails, validateSingleEmail } from "../cc-email-validator.js";
import { evaluateCompletionEligibility } from "../completion-eligibility.js";
import { buildCompletionMail } from "../completion-notification-mail.js";
import type { DispatchStorage } from "../dispatch-storage.js";
import type { TenantDataLoader } from "../tenant-data-loader.js";

// 型定義は `@lms-279/shared-types` に集約 (B タスクで移管完了)。
// CompletionDryRunResult / CompletionDryRunTarget / CompletionDryRunTenantSummary /
// CompletionDryRunSkipReason / DryRunMimePreview は FE / BE / CLI 全部 shared-types から import。

// ============================================================
// 定数 (CLI と同じ、変更時は両方を同期)
// ============================================================

/** settings 未保存テナント / フォールバック時の default 値 */
export const DEFAULT_SIGNATURE = "DXcollege運営スタッフ";
/** settings 未保存時の default 本文 (本番では doc 必須だが、cutover リハーサルでも preview を返せるように) */
export const DEFAULT_BODY =
  "(本文未設定 — super_dispatch_settings/global.completionMessageBody を保存してください)";

// ============================================================
// 依存性注入 interface
// ============================================================

/**
 * `runCompletionNotificationDryRun` の入力。
 *
 * `storage` は `Pick<DispatchStorage, ...>` で **明示的に read-only API のみ** に絞る
 * (Phase 4 α-7 AC-α7-06: read-only 保証の型レベル担保)。
 */
export interface RunCompletionNotificationDryRunInput {
  storage: Pick<
    DispatchStorage,
    "getDispatchSettings" | "getCompletionNotification"
  >;
  loader: TenantDataLoader;
  /**
   * From アドレス (CLI/endpoint で指定、env からは取得しない)。
   * 旧 CLI では `process.env.DXCOLLEGE_SENDER_EMAIL` (default `dxcollege@279279.net`)
   * を参照していたが、service module では引数化して副作用を排除。
   */
  senderEmail: string;
  /** test では fixed Date を inject、CLI / endpoint では `new Date()` */
  now?: Date;
}

// ============================================================
// メイン dry-run ロジック
// ============================================================

/**
 * 完了通知の dry-run を実行し、対象一覧 + MIME プレビューを返す。
 *
 * 旧 CLI の `runDryRunCli` を DI 化した実装。CLI 互換は A3 の薄 wrapper で維持する。
 */
export async function runCompletionNotificationDryRun(
  input: RunCompletionNotificationDryRunInput,
): Promise<CompletionDryRunResult> {
  const { storage, loader, senderEmail, now = new Date() } = input;

  // ① settings 読み取り
  // doc missing 許容: 初期化前 cutover リハーサル想定で default 文言で preview を返す。
  // read/parse error (throw) は cutover 判断材料の整合性に直結するため致命扱い。
  const settings: DispatchSettings | null = await storage.getDispatchSettings();

  const signature = settings?.signatureName ?? DEFAULT_SIGNATURE;
  const messageBody = settings?.completionMessageBody ?? DEFAULT_BODY;

  // ② tenants 走査
  const tenantIds = await loader.listAllTenantIds();
  const tenantsSummary: CompletionDryRunTenantSummary[] = [];
  const wouldNotify: CompletionDryRunTarget[] = [];

  for (const tenantId of tenantIds) {
    const ccConfig = await loader.getTenantCcConfig(tenantId);

    // テナント単位 disable は対象外 (本番 run-completion-notifications.ts の logic と整合)
    if (!ccConfig?.completionNotificationEnabled) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "tenant_completion_notification_disabled",
        usersScanned: 0,
        eligibleCount: 0,
      });
      continue;
    }

    const dataView = loader.getTenantDataView(tenantId);
    const publishedCourses = await dataView.listPublishedCourses();
    if (publishedCourses.length === 0) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "no_published_courses",
        usersScanned: 0,
        eligibleCount: 0,
      });
      continue;
    }

    const users = await dataView.listNotificationTargetUsers();
    let eligibleCount = 0;

    for (const user of users) {
      // email 無効はどのみち送信されない (AC-19)
      const emailV = validateSingleEmail(user.email);
      if (!emailV.ok) continue;

      const progresses = await dataView.listCourseProgressForUser(user.id);
      const eligibility = evaluateCompletionEligibility(
        publishedCourses,
        progresses,
      );
      if (!eligibility.eligible) continue;

      // 既存 notification (sent/reserved/failed/manual) は再送されない
      const existing = await storage.getCompletionNotification(tenantId, user.id);
      if (existing) continue;

      // MIME プレビュー組立
      const built = buildCompletionMail({
        userName: user.name,
        completionMessageBody: messageBody,
        signatureName: signature,
      });

      // CC 組立は本番送信側 (run-completion-notifications.ts) と完全同期させるため、
      // validateAndDedupeCcEmails を使う (trim / 形式検証 / CRLF・カンマ排除 /
      // case-insensitive dedupe を実施)。
      const ccResult = validateAndDedupeCcEmails(
        ccConfig.notificationCcEmails ?? [],
        ccConfig.ownerEmail,
      );
      const ccList = ccResult.validCcEmails;

      wouldNotify.push({
        tenantId,
        userId: user.id,
        userEmail: emailV.value,
        userName: user.name ?? "",
        courseIdsSnapshot: eligibility.courseIdsSnapshot,
        mimePreview: {
          from: `${signature} <${senderEmail}>`,
          to: emailV.value,
          cc: ccList,
          subject: built.subject,
          body: built.body,
        },
      });
      eligibleCount++;
    }

    tenantsSummary.push({
      tenantId,
      skipped: false,
      usersScanned: users.length,
      eligibleCount,
    });
  }

  return {
    lane: "completion",
    evaluatedAt: now.toISOString(),
    settingsLoaded: settings !== null,
    settingsSnapshot: settings
      ? {
          enabled: settings.enabled,
          scheduleDaysOfWeek: settings.scheduleDaysOfWeek,
          scheduleHourJst: settings.scheduleHourJst,
          signatureName: settings.signatureName,
          completionMessageBodyLength: settings.completionMessageBody.length,
        }
      : null,
    tenantsScanned: tenantIds.length,
    tenantsSummary,
    wouldNotifyCount: wouldNotify.length,
    wouldNotify,
  };
}
