/**
 * createDispatchTestSendRouter (Phase 5 POST /super/dispatch/test-send)。
 *
 * AC-9: 固定ダミーデータ + 添付なし + To=superAdmin.email 強制 + 1 日 50 件レート制限。
 * - 正常送信 → 200 { messageId, sentTo, sentAt }、To は強制的に superAdmin.email
 * - transient エラー → 503 gmail_api_transient
 * - permanent エラー → 502 gmail_api_error
 * - rateLimiter 注入で 429 rate_limit_exceeded
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";
import type {
  SendCompletionMailInput,
  SendCompletionMailResult,
} from "../../../services/dispatch/gmail-dwd-send.js";
import {
  createDispatchTestSendRouter,
  TEST_SEND_SUBJECT,
} from "../dispatch-test-send.js";

const NOW_ISO = "2026-05-22T01:00:00.000Z";
const ENV = { subjectEmail: "system@279279.net", fromEmail: "dxcollege@279279.net" };

function makeApp(opts: {
  sendMail: (i: SendCompletionMailInput) => Promise<SendCompletionMailResult>;
  rateLimiter?: express.RequestHandler;
  adminEmail?: string | null;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const email = opts.adminEmail === undefined ? "admin@example.com" : opts.adminEmail;
    if (email) {
      (req as express.Request & { superAdmin?: { email: string } }).superAdmin = {
        email,
      };
    }
    next();
  });
  app.use(
    "/api/v2/super",
    createDispatchTestSendRouter({
      env: ENV,
      sendMail: opts.sendMail,
      now: () => new Date(NOW_ISO),
      rateLimiter: opts.rateLimiter,
    }),
  );
  return app;
}

describe("POST /super/dispatch/test-send", () => {
  let sentInputs: SendCompletionMailInput[];
  beforeEach(() => {
    sentInputs = [];
  });

  it("固定ダミーで superAdmin 自身宛に送信し 200 を返す", async () => {
    const sendMail = vi.fn(async (input: SendCompletionMailInput) => {
      sentInputs.push(input);
      return { messageId: "msg-001", attempts: 1 } as SendCompletionMailResult;
    });
    const res = await request(makeApp({ sendMail })).post(
      "/api/v2/super/dispatch/test-send",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      messageId: "msg-001",
      sentTo: "admin@example.com",
      sentAt: NOW_ISO,
    });
    // To は superAdmin.email 強制、CC なし、固定件名、env から subject/from
    expect(sentInputs[0]).toMatchObject({
      to: "admin@example.com",
      cc: [],
      subject: TEST_SEND_SUBJECT,
      subjectEmail: ENV.subjectEmail,
      fromEmail: ENV.fromEmail,
    });
  });

  it("transient エラーは 503 gmail_api_transient", async () => {
    const transient = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    const sendMail = vi.fn(async () => {
      throw transient;
    });
    const res = await request(makeApp({ sendMail })).post(
      "/api/v2/super/dispatch/test-send",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("gmail_api_transient");
  });

  it("permanent エラーは 502 gmail_api_error", async () => {
    const sendMail = vi.fn(async () => {
      throw new Error("invalid recipient");
    });
    const res = await request(makeApp({ sendMail })).post(
      "/api/v2/super/dispatch/test-send",
    );
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("gmail_api_error");
  });

  it("superAdmin email が無いと 401 unauthorized", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "x" }) as SendCompletionMailResult);
    const res = await request(makeApp({ sendMail, adminEmail: null })).post(
      "/api/v2/super/dispatch/test-send",
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("rateLimiter で上限超過すると 429 rate_limit_exceeded", async () => {
    const tinyLimiter = rateLimit({
      windowMs: 60_000,
      limit: 1,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: () => "fixed-key",
      message: { error: "rate_limit_exceeded", message: "上限です" },
    });
    const sendMail = vi.fn(async () => ({ messageId: "m", attempts: 1 }) as SendCompletionMailResult);
    const app = makeApp({ sendMail, rateLimiter: tinyLimiter });
    const first = await request(app).post("/api/v2/super/dispatch/test-send");
    expect(first.status).toBe(200);
    const second = await request(app).post("/api/v2/super/dispatch/test-send");
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limit_exceeded");
  });
});
