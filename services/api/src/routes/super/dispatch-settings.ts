/**
 * スーパー管理者向け 自動完了通知 配信設定ルート (Phase 5)。
 *
 * GET  /api/v2/super/dispatch/settings  設定取得 (senderEmail は env 値で上書き)
 * PUT  /api/v2/super/dispatch/settings  設定更新 (楽観的ロック、version 不一致で 409)
 *
 * 認可は親 (index.ts) で superAdminAuthMiddleware を適用済 (AC-31)。
 * エラーは ADR-010 フラット形式 { error, message }。
 *
 * senderEmail は env DXCOLLEGE_SENDER_EMAIL 由来 (NFR-8、編集不可)。doc 未作成時は
 * GET で default 値 (enabled=false / version=0) を返し、初回 PUT (version=0) で create する。
 */

import { Router, type Request, type Response } from "express";
import {
  DISPATCH_CONSTRAINTS,
  type GetDispatchSettingsResponse,
  type PutDispatchSettingsRequest,
} from "@lms-279/shared-types";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";

/** 署名 default (現場要望 ③、design §4.1.1) */
export const DEFAULT_SIGNATURE_NAME = "DXcollege運営スタッフ";
/** 完了通知本文 default (現場要望 ④.1) */
export const DEFAULT_COMPLETION_MESSAGE_BODY =
  "受講お疲れ様でした。全受講修了致しました。ご質問やご相談がありましたら、本メールにご返信ください。";

export interface DispatchSettingsRouteDeps {
  storage: DispatchStorage;
  /** env DXCOLLEGE_SENDER_EMAIL (senderEmail として GET レスポンスに overlay) */
  senderEmail: string;
  /** updatedAt 用 now provider (テスト時固定可) */
  now?: () => Date;
}

/**
 * signatureName: 全 C0 制御文字 (CR/LF/TAB 含む、0x00-0x1f) を禁止する。
 * 署名は本文中に展開されるため、改行混入による表示偽装を防ぐ。
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * completionMessageBody: LF (0x0a) と TAB (0x09) のみ許可し、それ以外の C0 制御文字
 * (CR=0x0d 含む) を禁止する。本文は text/plain で改行 LF を含むため LF/TAB のみ許容。
 */
function hasForbiddenBodyControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a) return true;
  }
  return false;
}

export function createDispatchSettingsRouter(
  deps: DispatchSettingsRouteDeps,
): Router {
  const router = Router();
  const now = deps.now ?? ((): Date => new Date());

  router.get(
    "/dispatch/settings",
    async (_req: Request, res: Response): Promise<void> => {
      const stored = await deps.storage.getDispatchSettings();
      // senderEmail は env が真実 (NFR-8): stored の値に関わらず env で上書き
      const response: GetDispatchSettingsResponse = stored
        ? { ...stored, senderEmail: deps.senderEmail }
        : {
            enabled: false,
            scheduleDaysOfWeek: [],
            scheduleHourJst: 0,
            signatureName: DEFAULT_SIGNATURE_NAME,
            completionMessageBody: DEFAULT_COMPLETION_MESSAGE_BODY,
            senderEmail: deps.senderEmail,
            updatedAt: "",
            updatedBy: "",
            version: 0,
          };
      res.json(response);
    },
  );

  router.put(
    "/dispatch/settings",
    async (req: Request, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Partial<PutDispatchSettingsRequest>;

      if (typeof body.enabled !== "boolean") {
        res
          .status(400)
          .json({ error: "bad_request", message: "enabled は boolean が必要です。" });
        return;
      }
      if (
        typeof body.version !== "number" ||
        !Number.isInteger(body.version) ||
        body.version < 0
      ) {
        res
          .status(400)
          .json({ error: "bad_request", message: "version は 0 以上の整数が必要です。" });
        return;
      }
      if (
        !Array.isArray(body.scheduleDaysOfWeek) ||
        !body.scheduleDaysOfWeek.every(
          (d) => Number.isInteger(d) && d >= 0 && d <= 6,
        )
      ) {
        res.status(400).json({
          error: "invalid_schedule_days",
          message: "配信曜日は 0〜6 の整数配列が必要です。",
        });
        return;
      }
      if (
        typeof body.scheduleHourJst !== "number" ||
        !Number.isInteger(body.scheduleHourJst) ||
        body.scheduleHourJst < 0 ||
        body.scheduleHourJst > 23
      ) {
        res.status(400).json({
          error: "invalid_schedule_hour",
          message: "配信時刻は 0〜23 の整数が必要です。",
        });
        return;
      }
      if (
        typeof body.signatureName !== "string" ||
        body.signatureName.length >
          DISPATCH_CONSTRAINTS.SIGNATURE_NAME_MAX_LENGTH ||
        hasControlChar(body.signatureName)
      ) {
        res.status(400).json({
          error: "invalid_signature_name",
          message: `署名は ${DISPATCH_CONSTRAINTS.SIGNATURE_NAME_MAX_LENGTH} 文字以内で、改行・制御文字を含められません。`,
        });
        return;
      }
      if (
        typeof body.completionMessageBody !== "string" ||
        body.completionMessageBody.trim().length === 0 ||
        body.completionMessageBody.length >
          DISPATCH_CONSTRAINTS.COMPLETION_MESSAGE_BODY_MAX_LENGTH ||
        hasForbiddenBodyControlChar(body.completionMessageBody)
      ) {
        res.status(400).json({
          error: "invalid_completion_message_body",
          message: `本文は 1〜${DISPATCH_CONSTRAINTS.COMPLETION_MESSAGE_BODY_MAX_LENGTH} 文字で、CR・制御文字を含められません (改行 LF は可)。`,
        });
        return;
      }

      const outcome = await deps.storage.updateDispatchSettings({
        expectedVersion: body.version,
        enabled: body.enabled,
        scheduleDaysOfWeek: body.scheduleDaysOfWeek,
        scheduleHourJst: body.scheduleHourJst,
        signatureName: body.signatureName,
        completionMessageBody: body.completionMessageBody,
        senderEmail: deps.senderEmail,
        updatedBy: req.superAdmin?.email ?? "",
        updatedAt: now().toISOString(),
      });

      if (!outcome.updated) {
        res.status(409).json({
          error: "version_conflict",
          message:
            "設定が他のユーザーにより更新されています。最新の値を再読み込みしてください。",
        });
        return;
      }

      const response: GetDispatchSettingsResponse = {
        ...outcome.settings,
        senderEmail: deps.senderEmail,
      };
      res.json(response);
    },
  );

  return router;
}
