/**
 * createTenantNotificationCcRouter (Phase 5 GET/PUT /super/tenants/:id/notification-cc-emails)。
 *
 * - GET: 取得 / tenant_not_found 404 / 不正 tenantId
 * - PUT: 更新 / AC-24 (>10 件) / AC-25 (CRLF/カンマ/制御/形式) / dedup / 存在しない tenant
 *
 * Firestore I/O は in-memory fake TenantCcConfigStore を inject。
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { TenantNotificationCcConfig } from "@lms-279/shared-types";
import {
  createTenantNotificationCcRouter,
  type TenantCcConfigStore,
} from "../tenant-notification-cc.js";

class FakeStore implements TenantCcConfigStore {
  configs = new Map<string, TenantNotificationCcConfig>();
  updates: { tenantId: string; notificationCcEmails: string[]; enabled: boolean }[] =
    [];

  async getTenantCcConfig(
    tenantId: string,
  ): Promise<TenantNotificationCcConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }
  async updateTenantCcConfig(
    tenantId: string,
    input: { notificationCcEmails: string[]; completionNotificationEnabled: boolean },
  ): Promise<void> {
    this.updates.push({
      tenantId,
      notificationCcEmails: input.notificationCcEmails,
      enabled: input.completionNotificationEnabled,
    });
    const prev = this.configs.get(tenantId);
    this.configs.set(tenantId, {
      ownerEmail: prev?.ownerEmail ?? null,
      notificationCcEmails: input.notificationCcEmails,
      completionNotificationEnabled: input.completionNotificationEnabled,
    });
  }
}

function makeApp(store: TenantCcConfigStore) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { superAdmin?: { email: string } }).superAdmin = {
      email: "admin@example.com",
    };
    next();
  });
  app.use("/api/v2/super", createTenantNotificationCcRouter({ store }));
  return app;
}

describe("GET /super/tenants/:tenantId/notification-cc-emails", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it("既存テナントの CC config を返す", async () => {
    store.configs.set("atali82i", {
      ownerEmail: "owner@example.com",
      notificationCcEmails: ["cc1@example.com"],
      completionNotificationEnabled: true,
    });
    const res = await request(makeApp(store)).get(
      "/api/v2/super/tenants/atali82i/notification-cc-emails",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ownerEmail: "owner@example.com",
      notificationCcEmails: ["cc1@example.com"],
      completionNotificationEnabled: true,
    });
  });

  it("存在しないテナントは 404 tenant_not_found", async () => {
    const res = await request(makeApp(store)).get(
      "/api/v2/super/tenants/missing/notification-cc-emails",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("tenant_not_found");
  });

  it("不正な tenantId 形式は 404 tenant_not_found", async () => {
    const res = await request(makeApp(store)).get(
      "/api/v2/super/tenants/bad..id/notification-cc-emails",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("tenant_not_found");
  });
});

describe("PUT /super/tenants/:tenantId/notification-cc-emails", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
    store.configs.set("atali82i", {
      ownerEmail: "owner@example.com",
      notificationCcEmails: [],
      completionNotificationEnabled: true,
    });
  });

  it("CC を更新し、ownerEmail を保持して返す", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: ["a@example.com", "b@example.com"],
        completionNotificationEnabled: false,
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ownerEmail: "owner@example.com",
      notificationCcEmails: ["a@example.com", "b@example.com"],
      completionNotificationEnabled: false,
    });
    expect(store.updates).toHaveLength(1);
  });

  it("AC-24: 11 件以上は 400 cc_emails_too_many", async () => {
    const emails = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`);
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({ notificationCcEmails: emails, completionNotificationEnabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cc_emails_too_many");
    expect(store.updates).toHaveLength(0);
  });

  it("AC-25: CRLF を含む要素は 400 invalid_cc_emails", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: ["ok@example.com", "bad@example.com\r\nBcc: x@evil.com"],
        completionNotificationEnabled: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cc_emails");
  });

  it("AC-25: カンマを含む要素は 400 invalid_cc_emails", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: ["a@example.com,b@example.com"],
        completionNotificationEnabled: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cc_emails");
  });

  it("形式違反 (＠なし) は 400 invalid_cc_emails", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: ["not-an-email"],
        completionNotificationEnabled: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cc_emails");
  });

  it("大文字小文字違いの重複は dedup される (先勝ち)", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: ["Dup@Example.com", "dup@example.com", "x@example.com"],
        completionNotificationEnabled: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.notificationCcEmails).toEqual(["Dup@Example.com", "x@example.com"]);
  });

  it("存在しないテナントへの PUT は 404 tenant_not_found", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/missing/notification-cc-emails")
      .send({ notificationCcEmails: [], completionNotificationEnabled: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("tenant_not_found");
  });

  it("completionNotificationEnabled が boolean でないと 400 bad_request", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({ notificationCcEmails: [], completionNotificationEnabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });
});
