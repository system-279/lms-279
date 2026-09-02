/**
 * Cloud Monitoring のアラートポリシー（Uptime Check 失敗・Cloud Run 5xx 率等）が
 * Pub/Sub 通知チャネル経由で送ってくる incident 通知を Chat へ転送するハンドラ。
 *
 * ペイロード仕様: https://cloud.google.com/monitoring/support/notification-options#pubsub
 */

import type { Request, Response } from "express";
import { buildAvailabilityAlertText } from "./chat-payload-allowlist.js";
import { postToChat } from "./chat-client.js";
import { logger } from "./logger.js";

interface PubSubPushBody {
  message?: { data?: string; messageId?: string };
}

interface MonitoringIncidentPayload {
  incident?: {
    state?: string;
    policy_name?: string;
    summary?: string;
    url?: string;
  };
}

function decodePubSubData(body: PubSubPushBody): MonitoringIncidentPayload | undefined {
  const data = body.message?.data;
  if (!data) return undefined;
  try {
    const json = Buffer.from(data, "base64").toString("utf8");
    return JSON.parse(json) as MonitoringIncidentPayload;
  } catch {
    return undefined;
  }
}

export interface AvailabilityAlertDeps {
  webhookSecretName: string;
}

export function createAvailabilityAlertHandler(deps: AvailabilityAlertDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as PubSubPushBody;
    const payload = decodePubSubData(body);

    if (!payload?.incident) {
      logger.error("availability-alert: Pub/Sub message のデコードに失敗しました", {
        messageId: body.message?.messageId,
      });
      res.status(200).json({ ack: true, skipped: "decode_failed" });
      return;
    }

    const text = buildAvailabilityAlertText({
      state: (payload.incident.state ?? "unknown").toUpperCase(),
      policyName: payload.incident.policy_name ?? "(unknown policy)",
      summary: payload.incident.summary ?? "",
      url: payload.incident.url,
    });

    const result = await postToChat(text, deps.webhookSecretName);
    if (!result.ok) {
      const transient = result.status === undefined || result.status >= 500;
      res.status(transient ? 503 : 200).json({ ack: !transient });
      return;
    }

    res.status(200).json({ ack: true, posted: true });
  };
}
