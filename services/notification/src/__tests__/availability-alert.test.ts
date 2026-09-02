import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createAvailabilityAlertHandler } from "../availability-alert.js";

vi.mock("../chat-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat-client.js")>();
  return { ...actual, postToChat: vi.fn() };
});
import { postToChat } from "../chat-client.js";

const postToChatMock = vi.mocked(postToChat);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post(
    "/internal/availability-alert",
    createAvailabilityAlertHandler({ webhookSecretName: "secret" })
  );
  return app;
}

function makePubSubBody(incident: unknown) {
  return {
    message: {
      data: Buffer.from(JSON.stringify({ incident })).toString("base64"),
      messageId: "msg-1",
    },
  };
}

describe("availability-alert handler", () => {
  beforeEach(() => {
    postToChatMock.mockReset();
  });

  it("OPEN incidentをChatへ投稿する", async () => {
    postToChatMock.mockResolvedValue({ ok: true, status: 200 });
    const app = makeApp();

    const res = await request(app)
      .post("/internal/availability-alert")
      .send(
        makePubSubBody({
          state: "open",
          policy_name: "LMS API 5xx Error Rate",
          summary: "5xx errors > 5 in 5min",
          url: "https://console.cloud.google.com/x",
        })
      );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true, posted: true });
    const text = postToChatMock.mock.calls[0][0];
    expect(text).toContain("🔴");
    expect(text).toContain("LMS API 5xx Error Rate");
  });

  it("デコード失敗は200 ackでスキップする", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/internal/availability-alert")
      .send({ message: { data: "!!!invalid", messageId: "m1" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true, skipped: "decode_failed" });
    expect(postToChatMock).not.toHaveBeenCalled();
  });

  it("Chat投稿がtransient失敗(5xx)の場合は503", async () => {
    postToChatMock.mockResolvedValue({ ok: false, status: 500 });
    const app = makeApp();

    const res = await request(app)
      .post("/internal/availability-alert")
      .send(makePubSubBody({ state: "open", policy_name: "x", summary: "y" }));

    expect(res.status).toBe(503);
    expect(res.body.ack).toBe(false);
  });

  it("Chat投稿が429(レート制限)の場合もtransientとして503", async () => {
    postToChatMock.mockResolvedValue({ ok: false, status: 429 });
    const app = makeApp();

    const res = await request(app)
      .post("/internal/availability-alert")
      .send(makePubSubBody({ state: "open", policy_name: "x", summary: "y" }));

    expect(res.status).toBe(503);
  });

  it("Chat投稿が恒久失敗(4xx)の場合は200 ackを返しループさせない", async () => {
    postToChatMock.mockResolvedValue({ ok: false, status: 404 });
    const app = makeApp();

    const res = await request(app)
      .post("/internal/availability-alert")
      .send(makePubSubBody({ state: "open", policy_name: "x", summary: "y" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ack: true });
  });
});
