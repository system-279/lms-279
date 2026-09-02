import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createErrorAlertHandler } from "../error-alert.js";
import { InMemoryDedupStore } from "./test-helpers.js";

vi.mock("../chat-client.js", () => ({
  postToChat: vi.fn(),
}));
import { postToChat } from "../chat-client.js";

const postToChatMock = vi.mocked(postToChat);

const REPORTED_ERROR_EVENT_TYPE =
  "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

function makePubSubBody(logEntry: unknown, messageId = "msg-1") {
  return {
    message: {
      data: Buffer.from(JSON.stringify(logEntry)).toString("base64"),
      messageId,
    },
    subscription: "projects/lms-279/subscriptions/ops-error-alerts-sub",
  };
}

function makeReportedErrorLogEntry(overrides: Record<string, unknown> = {}) {
  return {
    insertId: "insert-1",
    timestamp: "2026-09-02T00:00:00.000Z",
    jsonPayload: {
      "@type": REPORTED_ERROR_EVENT_TYPE,
      message: "Internal server error",
      error: {
        name: "TypeError",
        message: "Cannot read property 'x' of undefined for user@example.com",
        stack: "TypeError: boom\n  at handler (index.ts:10:1)\n  at next (express.ts:5:5)",
      },
      url: "/api/v2/tenant-a/quizzes?email=user@example.com",
      method: "POST",
    },
    ...overrides,
  };
}

function makeApp(dedupStore = new InMemoryDedupStore()) {
  const app = express();
  app.use(express.json());
  app.post(
    "/internal/error-alert",
    createErrorAlertHandler({ dedupStore, webhookSecretName: "secret" })
  );
  return { app, dedupStore };
}

describe("error-alert handler", () => {
  beforeEach(() => {
    postToChatMock.mockReset();
  });

  it("正常系: ReportedErrorEventログを受け取りChatへ投稿する", async () => {
    postToChatMock.mockResolvedValue({ ok: true, status: 200 });
    const { app } = makeApp();

    const res = await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry()));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true, posted: true });
    expect(postToChatMock).toHaveBeenCalledTimes(1);
    const text = postToChatMock.mock.calls[0][0];
    expect(text).toContain("TypeError");
    expect(text).toContain("tenant: tenant-a");
    expect(text).toContain("POST /api/v2/tenant-a/quizzes");
    // クエリ文字列 + メールアドレスが本文に残らないこと
    expect(text).not.toContain("email=user@example.com");
    expect(text).toContain("u***@example.com");
  });

  it("@typeがReportedErrorEvent以外 → 200 ack、Chat投稿もdedupも呼ばれない", async () => {
    const { app, dedupStore } = makeApp();
    const decideSpy = vi.spyOn(dedupStore, "decide");

    const res = await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry({ jsonPayload: { "@type": "other" } })));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true, skipped: "not_reported_error_event" });
    expect(decideSpy).not.toHaveBeenCalled();
    expect(postToChatMock).not.toHaveBeenCalled();
  });

  it("Pub/Subデータのデコードに失敗 → 200 ack (恒久失敗として再配信を止める)", async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post("/internal/error-alert")
      .send({ message: { data: "not-valid-base64-json!!!", messageId: "msg-x" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true, skipped: "decode_failed" });
  });

  it("dedupが抑制判定した場合はChat投稿せず200 ackを返す", async () => {
    const dedupStore = new InMemoryDedupStore();
    vi.spyOn(dedupStore, "decide").mockResolvedValue({ shouldPost: false, suppressedSincePrevious: 0 });
    const { app } = makeApp(dedupStore);

    const res = await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry()));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true, suppressed: true });
    expect(postToChatMock).not.toHaveBeenCalled();
  });

  it("Chat投稿がtransient失敗(5xx相当)の場合は503を返しnackさせる", async () => {
    postToChatMock.mockResolvedValue({ ok: false, status: 503 });
    const { app } = makeApp();

    const res = await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry()));

    expect(res.status).toBe(503);
    expect(res.body.ack).toBe(false);
  });

  it("Chat投稿がネットワーク例外(status不明)の場合もtransientとして503を返す", async () => {
    postToChatMock.mockResolvedValue({ ok: false });
    const { app } = makeApp();

    const res = await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry()));

    expect(res.status).toBe(503);
  });

  it("Chat投稿が恒久失敗(4xx)の場合は200 ackを返しループさせない", async () => {
    postToChatMock.mockResolvedValue({ ok: false, status: 404 });
    const { app } = makeApp();

    const res = await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry()));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true, reason: "chat_post_failed_permanent" });
  });

  it("同一fingerprintの連続発生はウィンドウ内で1件のみ投稿される", async () => {
    postToChatMock.mockResolvedValue({ ok: true, status: 200 });
    const { app } = makeApp();

    await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry({ insertId: "insert-1" }), "m1"));
    await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry({ insertId: "insert-2" }), "m2"));
    await request(app)
      .post("/internal/error-alert")
      .send(makePubSubBody(makeReportedErrorLogEntry({ insertId: "insert-3" }), "m3"));

    expect(postToChatMock).toHaveBeenCalledTimes(1);
  });
});
