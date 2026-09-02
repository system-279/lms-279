/**
 * Cloud Scheduler（平日毎日）が呼ぶ、ヘルスチェック結果の Chat 投稿ハンドラ。
 *
 * 冪等性: JST 日付文字列をキーに Firestore へ送信済みマークを残す
 * （Cloud Scheduler の at-least-once retry による二重投稿を防ぐ）。
 * Chat 投稿自体が失敗した場合は送信済みマークを残さず 503 を返し、リトライさせる。
 */

import type { Request, Response } from "express";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { buildHealthReportText } from "./chat-payload-allowlist.js";
import { postToChat } from "./chat-client.js";
import { logger } from "./logger.js";

const IDEMPOTENCY_COLLECTION = "ops_health_report_sent";
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getJstDateString(now: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

export interface HealthReportDeps {
  db: Firestore;
  webhookSecretName: string;
  apiHealthReadyUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface ApiHealthReadyBody {
  status?: string;
  checks?: {
    firestore?: string;
    memory?: { heapUsedMB?: number };
  };
}

export function createHealthReportHandler(deps: HealthReportDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const now = (deps.now ?? (() => new Date()))();
    const jstDate = getJstDateString(now);
    const idempotencyRef = deps.db.collection(IDEMPOTENCY_COLLECTION).doc(jstDate);

    const existing = await idempotencyRef.get();
    if (existing.exists) {
      res.status(200).json({ skipped: "already_sent", date: jstDate });
      return;
    }

    const fetchImpl = deps.fetchImpl ?? fetch;
    let status: "ok" | "degraded" | "error" = "ok";
    let firestoreStatus = "unknown";
    let heapUsedMB: number | undefined;
    let detail: string | undefined;

    try {
      const apiRes = await fetchImpl(deps.apiHealthReadyUrl, { method: "GET" });
      const parsed = (await apiRes.json().catch(() => ({}))) as ApiHealthReadyBody;
      firestoreStatus = parsed.checks?.firestore ?? "unknown";
      heapUsedMB = parsed.checks?.memory?.heapUsedMB;
      status = apiRes.ok ? "ok" : "degraded";
      if (!apiRes.ok) {
        detail = `api /health/ready returned ${apiRes.status}`;
      }
    } catch (err) {
      status = "error";
      detail = err instanceof Error ? err.message : String(err);
      logger.error("health-report: api /health/ready の呼び出しに失敗しました", {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }

    const text = buildHealthReportText({
      date: jstDate,
      status,
      firestoreStatus,
      heapUsedMB,
      detail,
    });
    const result = await postToChat(text, deps.webhookSecretName);

    if (!result.ok) {
      res.status(503).json({ posted: false, reason: "chat_post_failed" });
      return;
    }

    await idempotencyRef.set({
      postedAt: now.toISOString(),
      ttlExpireAt: Timestamp.fromDate(new Date(now.getTime() + IDEMPOTENCY_TTL_MS)),
    });
    res.status(200).json({ posted: true, date: jstDate, status });
  };
}
