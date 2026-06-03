/**
 * スーパー管理者向け テナント別 CC 設定ルート (Phase 5)。
 *
 * GET  /api/v2/super/tenants/:tenantId/notification-cc-emails  CC 設定取得
 * PUT  /api/v2/super/tenants/:tenantId/notification-cc-emails  CC 設定更新
 *
 * CC は tenant doc (`tenants/{tenantId}`) の notificationCcEmails /
 * completionNotificationEnabled フィールドに保存する (loader と同じ場所)。ownerEmail は
 * 既存フィールドの read-only 参考表示。
 *
 * 認可は親 (index.ts) で superAdminAuthMiddleware を適用済 (AC-31)。
 * - AC-24: notificationCcEmails 11 件以上 → 400 cc_emails_too_many
 * - AC-25: CRLF / カンマ / 制御文字 / 形式違反を含む要素 → 400 invalid_cc_emails
 *
 * Firestore I/O は TenantCcConfigStore に分離 (テスト時は in-memory fake を inject)。
 */

import { Router, type Request, type Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import {
  DISPATCH_CONSTRAINTS,
  type GetTenantNotificationCcResponse,
  type PutTenantNotificationCcRequest,
  type TenantNotificationCcConfig,
} from "@lms-279/shared-types";
import { validateSingleEmail } from "../../services/dispatch/cc-email-validator.js";

/** Firestore doc ID として安全な tenantId のみ許可 (`/` 等で sub-collection 誤解釈を防ぐ) */
const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * tenant CC config の I/O 抽象。production は Firestore、test は in-memory fake。
 *
 * `progressReportEnabled` は Phase 3 (ADR-039 D-6) で追加。undefined を渡したときは
 * 既存値を保持 (patch semantics)、boolean を渡したときのみ書き換える。完了通知 OFF と
 * 進捗レポート OFF は独立に決裁したいテナント運用 (例: 完了通知のみ運用 / 進捗のみ運用)
 * に対応するため。
 */
export interface TenantCcConfigStore {
  /** tenant doc の CC config を取得。tenant doc 不在なら null */
  getTenantCcConfig(
    tenantId: string,
  ): Promise<TenantNotificationCcConfig | null>;
  /** notificationCcEmails / completionNotificationEnabled / progressReportEnabled を更新 (merge) */
  updateTenantCcConfig(
    tenantId: string,
    input: {
      notificationCcEmails: string[];
      completionNotificationEnabled: boolean;
      /** Phase 3 (ADR-039 D-6): undefined のとき既存値保持 (patch semantics) */
      progressReportEnabled?: boolean;
    },
  ): Promise<void>;
}

/**
 * env value (カンマ区切り文字列) を `seedTenantIds` 配列に変換する純粋関数。
 *
 * 仕様 (汚い入力に対する正規化):
 *   - undefined / "" → `[]` (env 未設定)
 *   - 各要素を trim、空文字エントリは除去 ("a,,b" → ["a","b"], " a " → ["a"])
 *   - 重複は除去せず保持 (constructor 側で重複 seed は冪等、上書きされるだけ)
 *
 * index.ts wiring (`InMemoryTenantCcConfigStore` への inject) と本ファイル test の
 * 両方で共通利用。env パース層の回帰を unit test で押さえる目的で独立 export。
 */
export function parseSeedTenantIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * test / E2E / local dev 用の InMemory 実装。
 *
 * production wiring (`FirestoreTenantCcConfigStore`) は Firestore credential 必須のため、
 * CI E2E / Firebase emulator 無し dev では使えない。本クラスは `DISPATCH_USE_IN_MEMORY=true`
 * のとき index.ts wiring で inject される。
 *
 * `seedTenantIds` で初期 tenant を登録 (default config: ownerEmail=null /
 * notificationCcEmails=[] / completionNotificationEnabled=true)。E2E spec で
 * `/super/tenants/demo/notification-cc-emails` を呼ぶ場合は env
 * `DISPATCH_IN_MEMORY_SEED_TENANTS=demo` で seed する。
 */
export class InMemoryTenantCcConfigStore implements TenantCcConfigStore {
  private readonly configs = new Map<string, TenantNotificationCcConfig>();

  constructor(options: { seedTenantIds?: string[] } = {}) {
    for (const tenantId of options.seedTenantIds ?? []) {
      this.configs.set(tenantId, {
        ownerEmail: null,
        notificationCcEmails: [],
        completionNotificationEnabled: true,
        // Phase 3 (ADR-039 D-6): default false (opt-in)
        progressReportEnabled: false,
      });
    }
  }

  async getTenantCcConfig(
    tenantId: string,
  ): Promise<TenantNotificationCcConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }

  async updateTenantCcConfig(
    tenantId: string,
    input: {
      notificationCcEmails: string[];
      completionNotificationEnabled: boolean;
      progressReportEnabled?: boolean;
    },
  ): Promise<void> {
    const prev = this.configs.get(tenantId);
    this.configs.set(tenantId, {
      ownerEmail: prev?.ownerEmail ?? null,
      notificationCcEmails: input.notificationCcEmails,
      completionNotificationEnabled: input.completionNotificationEnabled,
      // patch semantics: undefined のとき既存値保持 (default false)
      progressReportEnabled:
        input.progressReportEnabled !== undefined
          ? input.progressReportEnabled
          : (prev?.progressReportEnabled ?? false),
    });
  }
}

/** production wiring: tenants/{tenantId} doc を直接読み書き */
export class FirestoreTenantCcConfigStore implements TenantCcConfigStore {
  async getTenantCcConfig(
    tenantId: string,
  ): Promise<TenantNotificationCcConfig | null> {
    const snap = await getFirestore().collection("tenants").doc(tenantId).get();
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    return {
      ownerEmail: (data.ownerEmail as string | null) ?? null,
      notificationCcEmails: (data.notificationCcEmails as string[]) ?? [],
      // 既存テナント後方互換: 未設定は default true (loader と整合)
      completionNotificationEnabled:
        (data.completionNotificationEnabled as boolean | undefined) ?? true,
      // Phase 3 (ADR-039 D-6): 既存テナントは default false (opt-in)
      progressReportEnabled:
        (data.progressReportEnabled as boolean | undefined) ?? false,
    };
  }

  async updateTenantCcConfig(
    tenantId: string,
    input: {
      notificationCcEmails: string[];
      completionNotificationEnabled: boolean;
      progressReportEnabled?: boolean;
    },
  ): Promise<void> {
    // merge: 他の tenant フィールドを保護。
    // progressReportEnabled は undefined のとき payload に含めず既存値保持
    // (rules/production-data-safety.md §1)。route handler の同パターン spread と統一。
    await getFirestore()
      .collection("tenants")
      .doc(tenantId)
      .set(
        {
          notificationCcEmails: input.notificationCcEmails,
          completionNotificationEnabled: input.completionNotificationEnabled,
          ...(input.progressReportEnabled !== undefined && {
            progressReportEnabled: input.progressReportEnabled,
          }),
        },
        { merge: true },
      );
  }
}

export interface TenantNotificationCcRouteDeps {
  store: TenantCcConfigStore;
}

/** case-insensitive 重複排除 (先勝ち)、trim 済みの有効 email を保存用に整える */
function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of emails) {
    const trimmed = e.trim();
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function createTenantNotificationCcRouter(
  deps: TenantNotificationCcRouteDeps,
): Router {
  const router = Router();

  router.get(
    "/tenants/:tenantId/notification-cc-emails",
    async (req: Request, res: Response): Promise<void> => {
      const tenantId = req.params.tenantId as string;
      if (!TENANT_ID_REGEX.test(tenantId)) {
        res
          .status(404)
          .json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
        return;
      }
      const config = await deps.store.getTenantCcConfig(tenantId);
      if (!config) {
        res
          .status(404)
          .json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
        return;
      }
      const response: GetTenantNotificationCcResponse = config;
      res.json(response);
    },
  );

  router.put(
    "/tenants/:tenantId/notification-cc-emails",
    async (req: Request, res: Response): Promise<void> => {
      const tenantId = req.params.tenantId as string;
      if (!TENANT_ID_REGEX.test(tenantId)) {
        res
          .status(404)
          .json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
        return;
      }

      const body = (req.body ?? {}) as Partial<PutTenantNotificationCcRequest>;

      if (typeof body.completionNotificationEnabled !== "boolean") {
        res.status(400).json({
          error: "bad_request",
          message: "completionNotificationEnabled は boolean が必要です。",
        });
        return;
      }
      // Phase 3 (ADR-039 D-6): progressReportEnabled は optional。送信時のみ
      // type を検証し、未送信なら storage 層で既存値保持 (patch semantics)。
      // 旧 UI 由来の PUT は progressReportEnabled を含まないため、既存値が消えない。
      if (
        body.progressReportEnabled !== undefined &&
        typeof body.progressReportEnabled !== "boolean"
      ) {
        res.status(400).json({
          error: "bad_request",
          message: "progressReportEnabled は boolean が必要です。",
        });
        return;
      }
      if (!Array.isArray(body.notificationCcEmails)) {
        res.status(400).json({
          error: "invalid_cc_emails",
          message: "notificationCcEmails は文字列配列が必要です。",
        });
        return;
      }
      // AC-24: 上限超過
      if (
        body.notificationCcEmails.length >
        DISPATCH_CONSTRAINTS.NOTIFICATION_CC_EMAILS_MAX
      ) {
        res.status(400).json({
          error: "cc_emails_too_many",
          message: `CC は最大 ${DISPATCH_CONSTRAINTS.NOTIFICATION_CC_EMAILS_MAX} 件までです。`,
        });
        return;
      }
      // AC-25: 各要素を個別 validate。1 件でも不正なら request 全体を拒否 (admin に修正させる)
      for (const entry of body.notificationCcEmails) {
        const result = validateSingleEmail(entry);
        if (!result.ok) {
          res.status(400).json({
            error: "invalid_cc_emails",
            message: `CC email に不正な値が含まれます (理由: ${result.reason})。CRLF・カンマ・制御文字・形式違反は登録できません。`,
          });
          return;
        }
      }

      // tenant 存在確認
      const existing = await deps.store.getTenantCcConfig(tenantId);
      if (!existing) {
        res
          .status(404)
          .json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
        return;
      }

      const deduped = dedupeEmails(body.notificationCcEmails);
      await deps.store.updateTenantCcConfig(tenantId, {
        notificationCcEmails: deduped,
        completionNotificationEnabled: body.completionNotificationEnabled,
        // 未送信なら storage 層で既存値保持 (patch semantics、ADR-039 D-6)
        ...(body.progressReportEnabled !== undefined && {
          progressReportEnabled: body.progressReportEnabled,
        }),
      });

      // 応答は更新後の整合値: 送信されたら採用、未送信なら既存値を引き継ぐ
      const effectiveProgressReportEnabled =
        body.progressReportEnabled !== undefined
          ? body.progressReportEnabled
          : (existing.progressReportEnabled ?? false);
      const response: GetTenantNotificationCcResponse = {
        ownerEmail: existing.ownerEmail,
        notificationCcEmails: deduped,
        completionNotificationEnabled: body.completionNotificationEnabled,
        progressReportEnabled: effectiveProgressReportEnabled,
      };
      res.json(response);
    },
  );

  return router;
}
