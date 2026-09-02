/**
 * Cloud Logging Sink → Pub/Sub push で届く api の ERROR ログを Chat へ通知するハンドラ。
 *
 * Sink のフィルタは `service_name="api" AND jsonPayload."@type"=".../ReportedErrorEvent"`
 * を想定しているが（provisioning 側の設定）、本ハンドラでも防御的に @type を再検証する。
 */

import type { Request, Response } from "express";
import {
  buildErrorAlertText,
  extractTenantId,
  maskPii,
  stripQuery,
  topStackFrames,
} from "./chat-payload-allowlist.js";
import { computeFingerprint, normalizeMessage } from "./fingerprint.js";
import type { DedupStore } from "./dedup.js";
import { postToChat } from "./chat-client.js";
import { logger } from "./logger.js";

const REPORTED_ERROR_EVENT_TYPE =
  "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";
const STACK_FRAME_LIMIT = 5;

interface PubSubPushBody {
  message?: {
    data?: string;
    messageId?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

interface LogEntryEnvelope {
  insertId?: string;
  timestamp?: string;
  jsonPayload?: {
    message?: string;
    "@type"?: string;
    error?: { name?: string; message?: string; stack?: string };
    url?: string;
    method?: string;
  };
}

export interface ErrorAlertDeps {
  dedupStore: DedupStore;
  webhookSecretName: string;
  loggingLinkBuilder?: (insertId: string) => string;
}

function decodePubSubData(body: PubSubPushBody): LogEntryEnvelope | undefined {
  const data = body.message?.data;
  if (!data) return undefined;
  try {
    const json = Buffer.from(data, "base64").toString("utf8");
    return JSON.parse(json) as LogEntryEnvelope;
  } catch {
    return undefined;
  }
}

function buildLoggingLink(insertId: string): string {
  return `https://console.cloud.google.com/logs/query;query=insertId%3D%22${encodeURIComponent(
    insertId
  )}%22`;
}

export function createErrorAlertHandler(deps: ErrorAlertDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as PubSubPushBody;
    const messageId = body.message?.messageId ?? "";
    const entry = decodePubSubData(body);

    if (!entry) {
      // 整形不能 = 恒久的失敗。ack して再配信ループを止める。
      logger.error("error-alert: Pub/Sub message のデコードに失敗しました", { messageId });
      res.status(200).json({ ack: true, skipped: "decode_failed" });
      return;
    }

    if (entry.jsonPayload?.["@type"] !== REPORTED_ERROR_EVENT_TYPE) {
      // Sink フィルタ想定外の対象外ログ。防御的スキップ（ack）。
      res.status(200).json({ ack: true, skipped: "not_reported_error_event" });
      return;
    }

    const insertId = entry.insertId ?? messageId;
    if (!insertId) {
      logger.error("error-alert: insertId も messageId も取得できません", {});
      res.status(200).json({ ack: true, skipped: "no_insert_id" });
      return;
    }

    const errorName = entry.jsonPayload.error?.name ?? "Error";
    const rawMessage = entry.jsonPayload.error?.message ?? entry.jsonPayload.message ?? "";
    const stackFrames = topStackFrames(entry.jsonPayload.error?.stack, STACK_FRAME_LIMIT);
    const path = stripQuery(entry.jsonPayload.url);
    const tenantId = extractTenantId(path);
    const timestamp = entry.timestamp ?? new Date().toISOString();

    const fingerprint = computeFingerprint(
      errorName,
      stackFrames[0] ?? "",
      normalizeMessage(maskPii(rawMessage))
    );

    let decision;
    try {
      decision = await deps.dedupStore.decide(fingerprint, insertId, new Date().toISOString());
    } catch (err) {
      // dedup 自体が想定外に失敗した場合も通知は失わない(個別投稿として扱う)
      logger.error("error-alert: dedup 判定に失敗しました。個別投稿にフォールバックします", {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      decision = { shouldPost: true, suppressedSincePrevious: 0 };
    }

    if (!decision.shouldPost) {
      res.status(200).json({ ack: true, suppressed: true });
      return;
    }

    const loggingLink = (deps.loggingLinkBuilder ?? buildLoggingLink)(insertId);
    const text = buildErrorAlertText({
      timestamp,
      errorName,
      message: rawMessage,
      method: entry.jsonPayload.method,
      path,
      tenantId,
      stackFrames,
      loggingLink,
      suppressedSincePrevious: decision.suppressedSincePrevious,
    });

    const result = await postToChat(text, deps.webhookSecretName);
    if (!result.ok) {
      const transient = result.status === undefined || result.status >= 500;
      if (transient) {
        // decide() が既に書き込んだ状態を打ち消す。呼ばないと、Pub/Sub の再配信時に
        // 同じ insertId が seenInsertIds に残っているため shouldPost:false と判定され、
        // このアラートが永久に失われる（codex review 指摘）。
        await deps.dedupStore.rollback(fingerprint, insertId);
        // Pub/Sub に nack させ再配信させる
        res.status(503).json({ ack: false, reason: "chat_post_failed_transient" });
        return;
      }
      // 恒久失敗（Webhook 失効等）。ack してループさせない。
      // notification 自身の障害は別経路（Cloud Monitoring ログベースメトリクス）で検知する。
      res.status(200).json({ ack: true, reason: "chat_post_failed_permanent" });
      return;
    }

    res.status(200).json({ ack: true, posted: true });
  };
}
