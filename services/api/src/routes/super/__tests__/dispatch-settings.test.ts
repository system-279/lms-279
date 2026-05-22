/**
 * createDispatchSettingsRouter (Phase 5 GET/PUT /super/dispatch/settings) のテスト。
 *
 * - GET: doc 未作成 → default (version=0, signatureName default, senderEmail=env)
 * - GET: 既存 → senderEmail を env 値で上書き
 * - PUT: 作成 / 更新 / version_conflict 409 / 各 validation 400
 *
 * 認可は親で適用される前提のため、テストでは fake superAdmin middleware を挟む。
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  DISPATCH_CONSTRAINTS,
  type PutDispatchSettingsRequest,
} from "@lms-279/shared-types";
import { InMemoryDispatchStorage } from "../../../services/dispatch/in-memory-dispatch-storage.js";
import {
  createDispatchSettingsRouter,
  DEFAULT_SIGNATURE_NAME,
  DEFAULT_COMPLETION_MESSAGE_BODY,
} from "../dispatch-settings.js";

const SENDER = "dxcollege@279279.net";
const ADMIN = "admin@example.com";
const NOW_ISO = "2026-05-22T01:00:00.000Z";

function makeApp(storage: InMemoryDispatchStorage) {
  const app = express();
  app.use(express.json());
  // fake super-admin auth (親 router 相当)
  app.use((req, _res, next) => {
    (req as express.Request & { superAdmin?: { email: string } }).superAdmin = {
      email: ADMIN,
    };
    next();
  });
  app.use(
    "/api/v2/super",
    createDispatchSettingsRouter({
      storage,
      senderEmail: SENDER,
      now: () => new Date(NOW_ISO),
    }),
  );
  return app;
}

const validBody: PutDispatchSettingsRequest = {
  enabled: true,
  scheduleDaysOfWeek: [1, 4],
  scheduleHourJst: 9,
  signatureName: "DXcollege運営スタッフ",
  completionMessageBody: "受講お疲れ様でした。\n全受講修了致しました。",
  version: 0,
};

describe("GET /super/dispatch/settings", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("doc 未作成なら default 値 (version=0, senderEmail=env) を返す", async () => {
    const res = await request(makeApp(storage)).get("/api/v2/super/dispatch/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      scheduleDaysOfWeek: [],
      scheduleHourJst: 0,
      signatureName: DEFAULT_SIGNATURE_NAME,
      completionMessageBody: DEFAULT_COMPLETION_MESSAGE_BODY,
      senderEmail: SENDER,
      version: 0,
    });
  });

  it("既存 doc の senderEmail を env 値で上書きして返す", async () => {
    await storage.updateDispatchSettings({
      ...validBody,
      expectedVersion: 0,
      senderEmail: "stale@old.example", // stored stale value
      updatedBy: ADMIN,
      updatedAt: NOW_ISO,
    });
    const res = await request(makeApp(storage)).get("/api/v2/super/dispatch/settings");
    expect(res.status).toBe(200);
    expect(res.body.senderEmail).toBe(SENDER); // env で上書き
    expect(res.body.version).toBe(1);
  });
});

describe("PUT /super/dispatch/settings", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("初回 PUT (version=0) で作成され version=1、updatedBy=admin", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.updatedBy).toBe(ADMIN);
    expect(res.body.updatedAt).toBe(NOW_ISO);
    expect(res.body.senderEmail).toBe(SENDER);
  });

  it("version 不一致は 409 version_conflict", async () => {
    await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send(validBody); // → v1
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, version: 0 }); // stale
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("version_conflict");
    // current を返し UI reload を可能にする (senderEmail は env overlay)
    expect(res.body.current).toMatchObject({ version: 1, senderEmail: SENDER });
  });

  it("scheduleDaysOfWeek に 7 を含むと 400 invalid_schedule_days", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, scheduleDaysOfWeek: [1, 7] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_schedule_days");
  });

  it("scheduleHourJst=24 は 400 invalid_schedule_hour", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, scheduleHourJst: 24 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_schedule_hour");
  });

  it("signatureName に改行を含むと 400 invalid_signature_name", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, signatureName: "運営\nスタッフ" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature_name");
  });

  it("signatureName が上限超過で 400", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({
        ...validBody,
        signatureName: "あ".repeat(
          DISPATCH_CONSTRAINTS.SIGNATURE_NAME_MAX_LENGTH + 1,
        ),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature_name");
  });

  it("completionMessageBody に LF 改行を含むのは許可される (200)", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, completionMessageBody: "1 行目\n2 行目\n3 行目" });
    expect(res.status).toBe(200);
  });

  it("completionMessageBody に CR を含むと 400 invalid_completion_message_body", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, completionMessageBody: "1 行目\r\n2 行目" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_completion_message_body");
  });

  it("completionMessageBody が空文字は 400", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, completionMessageBody: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_completion_message_body");
  });

  it("enabled が boolean でないと 400 bad_request", async () => {
    const res = await request(makeApp(storage))
      .put("/api/v2/super/dispatch/settings")
      .send({ ...validBody, enabled: "yes" as unknown as boolean });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });
});
