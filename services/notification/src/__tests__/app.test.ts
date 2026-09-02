import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Firestore } from "@google-cloud/firestore";
import { createApp } from "../app.js";
import { InMemoryDedupStore, makeFakeOidcVerifier } from "./test-helpers.js";
import { FakeFirestore } from "./fake-firestore.js";

describe("createApp", () => {
  it("/health と /healthz は認証不要でokを返す", async () => {
    const app = createApp({
      db: new FakeFirestore().asFirestore(),
      dedupStore: new InMemoryDedupStore(),
    });

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });

    const healthz = await request(app).get("/healthz");
    expect(healthz.status).toBe(200);
  });

  it.each([
    "/internal/health-report",
    "/internal/flush",
    "/internal/error-alert",
    "/internal/availability-alert",
  ])("%s はAuthorizationヘッダ無しだと401を返す", async (path) => {
    const app = createApp({
      db: new FakeFirestore().asFirestore(),
      dedupStore: new InMemoryDedupStore(),
    });

    const res = await request(app).post(path).send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
  });

  it("scheduler向けroute用のverifierがpubsub向けrouteに対しても同じ挙動になる（audience不一致は各routeで独立に検証される）", async () => {
    const verifier = makeFakeOidcVerifier({
      email: "unexpected@lms-279.iam.gserviceaccount.com",
      subject: "1",
      audience: "https://x",
    });
    const app = createApp({
      db: new FakeFirestore().asFirestore(),
      dedupStore: new InMemoryDedupStore(),
      oidcVerifier: verifier,
      schedulerAudience: "https://notification/internal/health-report",
      schedulerCallerEmails: ["scheduler@lms-279.iam.gserviceaccount.com"],
      pubsubAudience: "https://notification/internal/error-alert",
      pubsubCallerEmails: ["pubsub@lms-279.iam.gserviceaccount.com"],
    });

    const res = await request(app)
      .post("/internal/health-report")
      .set("Authorization", "Bearer token")
      .send({});

    // verifierはemailを検証するがallowlistに含まれないためcaller_not_allowedになる
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("caller_not_allowed");
  });

  it("未定義のルートは404をADR-010互換のフラット形式で返す", async () => {
    const app = createApp({
      db: new FakeFirestore().asFirestore(),
      dedupStore: new InMemoryDedupStore(),
    });

    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "not_found",
      message: "Route GET /no-such-route not found",
    });
  });

  it("ハンドラ内の未捕捉例外はグローバルエラーハンドラで500・フラット形式にする（Express5の自動catchを利用）", async () => {
    const verifier = makeFakeOidcVerifier({
      email: "scheduler@lms-279.iam.gserviceaccount.com",
      subject: "1",
      audience: "https://x",
    });
    const brokenDb = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async () => {
        throw new Error("firestore FAILED_PRECONDITION: index not ready");
      },
    };
    const app = createApp({
      db: brokenDb as unknown as Firestore,
      dedupStore: new InMemoryDedupStore(),
      oidcVerifier: verifier,
      schedulerAudience: "https://notification",
      schedulerCallerEmails: ["scheduler@lms-279.iam.gserviceaccount.com"],
    });

    const res = await request(app)
      .post("/internal/health-report")
      .set("Authorization", "Bearer token")
      .send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "Internal server error" });
  });
});
