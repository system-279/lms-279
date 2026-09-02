/**
 * Cloud Scheduler（平日毎日）が呼ぶ、ヘルスチェック結果の Chat 投稿ハンドラ。
 *
 * 冪等性: JST 日付文字列をキーに、Firestore トランザクションで「予約」をアトミックに
 * 確保してから外部副作用（api 呼び出し・Chat 投稿）を行う（codex review 指摘。
 * read-then-write では複数の Scheduler 配信が同時に来た場合に両方とも素通りしうる）。
 * Chat 投稿が transient 失敗した場合は予約を解除し、Scheduler のリトライで再度
 * 予約できるようにする。permanent 失敗（Webhook 失効等）の場合は予約を残したまま
 * 200 を返し、Scheduler の無限リトライを防ぐ（別経路のログベースメトリクスで検知する）。
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
    const ttlExpireAt = Timestamp.fromDate(new Date(now.getTime() + IDEMPOTENCY_TTL_MS));

    const claimed = await deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(idempotencyRef);
      if (snap.exists) return false;
      tx.set(idempotencyRef, { claimedAt: now.toISOString(), postedAt: null, ttlExpireAt });
      return true;
    });

    if (!claimed) {
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
      const transient = result.status === undefined || result.status >= 500;
      if (transient) {
        // 予約を解除し、Scheduler のリトライで再度予約できるようにする
        await idempotencyRef.delete();
        res.status(503).json({ posted: false, reason: "chat_post_failed_transient" });
        return;
      }
      // 恒久失敗（Webhook 失効等）。予約は残したまま ack し、Scheduler の
      // 無限リトライを防ぐ。notification 自身の障害は別経路で検知する。
      res.status(200).json({ posted: false, reason: "chat_post_failed_permanent" });
      return;
    }

    await idempotencyRef.set({
      claimedAt: now.toISOString(),
      postedAt: now.toISOString(),
      ttlExpireAt,
    });
    res.status(200).json({ posted: true, date: jstDate, status });
  };
}
