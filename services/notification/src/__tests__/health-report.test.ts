import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHealthReportHandler, getJstDateString } from "../health-report.js";
import { FakeFirestore } from "./fake-firestore.js";

vi.mock("../chat-client.js", () => ({
  postToChat: vi.fn(),
}));
import { postToChat } from "../chat-client.js";

const postToChatMock = vi.mocked(postToChat);

function makeApp(deps: Parameters<typeof createHealthReportHandler>[0]) {
  const app = express();
  app.use(express.json());
  app.post("/internal/health-report", createHealthReportHandler(deps));
  return app;
}

describe("getJstDateString", () => {
  it("UTC日付をJST日付文字列(YYYY-MM-DD)に変換する", () => {
    // UTC 2026-09-01 15:30 = JST 2026-09-02 00:30
    expect(getJstDateString(new Date("2026-09-01T15:30:00.000Z"))).toBe("2026-09-02");
  });

  it("UTC日付でJSTでも同日になるケース", () => {
    // UTC 2026-09-02 00:00 = JST 2026-09-02 09:00
    expect(getJstDateString(new Date("2026-09-02T00:00:00.000Z"))).toBe("2026-09-02");
  });
});

describe("health-report handler", () => {
  it("api /health/ready がokを返す場合、Chatに投稿し送信済みマークを残す", async () => {
    const db = new FakeFirestore();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", checks: { firestore: "ok", memory: { heapUsedMB: 50 } } }), {
        status: 200,
      })
    );
    postToChatMock.mockResolvedValue({ ok: true, status: 200 });

    const app = makeApp({
      db: db.asFirestore(),
      webhookSecretName: "secret",
      apiHealthReadyUrl: "https://api.example.com/health/ready",
      fetchImpl,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    const res = await request(app).post("/internal/health-report");

    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(true);
    expect(postToChatMock).toHaveBeenCalledWith(expect.stringContaining("✅"), "secret");

    const doc = await db.collection("ops_health_report_sent").doc("2026-09-02").get();
    expect(doc.exists).toBe(true);
  });

  it("同一JST日付で2回目の呼び出しは投稿せずスキップする（冪等性）", async () => {
    const db = new FakeFirestore();
    await db.collection("ops_health_report_sent").doc("2026-09-02").set({ postedAt: "x" });
    const fetchImpl = vi.fn();
    postToChatMock.mockClear();

    const app = makeApp({
      db: db.asFirestore(),
      webhookSecretName: "secret",
      apiHealthReadyUrl: "https://api.example.com/health/ready",
      fetchImpl,
      now: () => new Date("2026-09-02T05:00:00.000Z"),
    });

    const res = await request(app).post("/internal/health-report");

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe("already_sent");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postToChatMock).not.toHaveBeenCalled();
  });

  it("api呼び出しが例外を投げてもクラッシュせず、errorステータスで投稿を試みる", async () => {
    const db = new FakeFirestore();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    postToChatMock.mockResolvedValue({ ok: true, status: 200 });

    const app = makeApp({
      db: db.asFirestore(),
      webhookSecretName: "secret",
      apiHealthReadyUrl: "https://api.example.com/health/ready",
      fetchImpl,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    const res = await request(app).post("/internal/health-report");

    expect(res.status).toBe(200);
    expect(postToChatMock).toHaveBeenCalledWith(expect.stringContaining("🔴"), "secret");
  });

  it("Chat投稿がtransient失敗(5xx)した場合は503を返し、予約を解除する（リトライさせる）", async () => {
    const db = new FakeFirestore();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", checks: { firestore: "ok" } }), { status: 200 })
    );
    postToChatMock.mockResolvedValue({ ok: false, status: 500 });

    const app = makeApp({
      db: db.asFirestore(),
      webhookSecretName: "secret",
      apiHealthReadyUrl: "https://api.example.com/health/ready",
      fetchImpl,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    const res = await request(app).post("/internal/health-report");

    expect(res.status).toBe(503);
    const doc = await db.collection("ops_health_report_sent").doc("2026-09-02").get();
    expect(doc.exists).toBe(false);
  });

  it("予約解除後の再試行では改めてクレームでき、成功すれば投稿される", async () => {
    const db = new FakeFirestore();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", checks: { firestore: "ok" } }), { status: 200 })
    );
    const app = makeApp({
      db: db.asFirestore(),
      webhookSecretName: "secret",
      apiHealthReadyUrl: "https://api.example.com/health/ready",
      fetchImpl,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    postToChatMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const first = await request(app).post("/internal/health-report");
    expect(first.status).toBe(503);

    postToChatMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const retry = await request(app).post("/internal/health-report");
    expect(retry.status).toBe(200);
    expect(retry.body.posted).toBe(true);
  });

  it("Chat投稿が恒久失敗(4xx)した場合は200を返しSchedulerを無限リトライさせない。予約は残す", async () => {
    const db = new FakeFirestore();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", checks: { firestore: "ok" } }), { status: 200 })
    );
    postToChatMock.mockResolvedValue({ ok: false, status: 404 });

    const app = makeApp({
      db: db.asFirestore(),
      webhookSecretName: "secret",
      apiHealthReadyUrl: "https://api.example.com/health/ready",
      fetchImpl,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    const res = await request(app).post("/internal/health-report");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ posted: false, reason: "chat_post_failed_permanent" });
    const doc = await db.collection("ops_health_report_sent").doc("2026-09-02").get();
    expect(doc.exists).toBe(true); // 予約は残り、その日はもう再送しない
  });
});
