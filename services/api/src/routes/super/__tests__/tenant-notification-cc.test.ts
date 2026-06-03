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
  InMemoryTenantCcConfigStore,
  parseSeedTenantIds,
  type TenantCcConfigStore,
} from "../tenant-notification-cc.js";

class FakeStore implements TenantCcConfigStore {
  configs = new Map<string, TenantNotificationCcConfig>();
  updates: {
    tenantId: string;
    notificationCcEmails: string[];
    enabled: boolean;
    /** Phase 3 (ADR-039 D-6): undefined = 未送信 (patch semantics で既存値保持) */
    progressReportEnabled?: boolean;
  }[] = [];

  async getTenantCcConfig(
    tenantId: string,
  ): Promise<TenantNotificationCcConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }
  async updateTenantCcConfig(
    tenantId: string,
    input: {
      notificationCcEmails: string[];
      completionNotificationEnabled: boolean;
      progressReportEnabled?: boolean;
    },
  ): Promise<void> {
    this.updates.push({
      tenantId,
      notificationCcEmails: input.notificationCcEmails,
      enabled: input.completionNotificationEnabled,
      progressReportEnabled: input.progressReportEnabled,
    });
    const prev = this.configs.get(tenantId);
    this.configs.set(tenantId, {
      ownerEmail: prev?.ownerEmail ?? null,
      notificationCcEmails: input.notificationCcEmails,
      completionNotificationEnabled: input.completionNotificationEnabled,
      // patch semantics: undefined のとき既存値保持 (default false)
      progressReportEnabled:
        input.progressReportEnabled !== undefined
          ? input.progressReportEnabled
          : (prev?.progressReportEnabled ?? false),
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
      progressReportEnabled: true,
    });
    const res = await request(makeApp(store)).get(
      "/api/v2/super/tenants/atali82i/notification-cc-emails",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ownerEmail: "owner@example.com",
      notificationCcEmails: ["cc1@example.com"],
      completionNotificationEnabled: true,
      progressReportEnabled: true,
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
      progressReportEnabled: false,
    });
  });

  it("CC を更新し、ownerEmail を保持して返す (progressReportEnabled は既存値継承)", async () => {
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
      // 旧 UI 由来の PUT (progressReportEnabled 未送信) で既存値 false を保持
      progressReportEnabled: false,
    });
    expect(store.updates).toHaveLength(1);
    // store には未送信 (undefined) で patch される (Firestore merge で既存値保持される)
    expect(store.updates[0]!.progressReportEnabled).toBeUndefined();
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

  // ============================================================
  // Phase 3 ADR-039 D-6: progressReportEnabled patch semantics
  // ============================================================

  it("progressReportEnabled を含めて PUT すると保存され、response にも含まれる", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: [],
        completionNotificationEnabled: true,
        progressReportEnabled: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.progressReportEnabled).toBe(true);
    expect(store.updates[0]!.progressReportEnabled).toBe(true);
  });

  it("progressReportEnabled=true 既存テナントに対し未送信 PUT で既存値 true を保持する (AC-PR-19)", async () => {
    // 事前に true を保存
    await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: [],
        completionNotificationEnabled: true,
        progressReportEnabled: true,
      });
    // 旧 UI 由来の PUT (progressReportEnabled なし)
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: ["cc@example.com"],
        completionNotificationEnabled: false,
      });
    expect(res.status).toBe(200);
    // 完了通知 OFF は反映されるが、進捗レポート ON は既存値保持
    expect(res.body.completionNotificationEnabled).toBe(false);
    expect(res.body.progressReportEnabled).toBe(true);
  });

  it("progressReportEnabled が boolean でないと 400 bad_request", async () => {
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: [],
        completionNotificationEnabled: true,
        progressReportEnabled: "yes",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  // Codex セカンドオピニオン LOW 指摘: 既存 true を明示 false で OFF にする境界テスト。
  // 将来 `...(body.progressReportEnabled && ...)` のような truthy 判定退行を検知するため。
  it("既存 progressReportEnabled=true を明示 false で送信すると false に更新される (truthy 退行防止)", async () => {
    // 事前に true を保存
    await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: [],
        completionNotificationEnabled: true,
        progressReportEnabled: true,
      });
    // 明示 false で OFF
    const res = await request(makeApp(store))
      .put("/api/v2/super/tenants/atali82i/notification-cc-emails")
      .send({
        notificationCcEmails: [],
        completionNotificationEnabled: true,
        progressReportEnabled: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.progressReportEnabled).toBe(false);
    // store にも false が伝播 (truthy 判定退行なら undefined になり既存値 true が保持されてしまう)
    const lastUpdate = store.updates[store.updates.length - 1]!;
    expect(lastUpdate.progressReportEnabled).toBe(false);
  });
});

describe("InMemoryTenantCcConfigStore", () => {
  it("seedTenantIds で指定したテナントは default config で初期化される (progressReportEnabled=false)", async () => {
    const store = new InMemoryTenantCcConfigStore({
      seedTenantIds: ["demo", "tenant-a"],
    });
    expect(await store.getTenantCcConfig("demo")).toEqual({
      ownerEmail: null,
      notificationCcEmails: [],
      completionNotificationEnabled: true,
      // Phase 3 (ADR-039 D-6): default false (opt-in)
      progressReportEnabled: false,
    });
    expect(await store.getTenantCcConfig("tenant-a")).toEqual({
      ownerEmail: null,
      notificationCcEmails: [],
      completionNotificationEnabled: true,
      progressReportEnabled: false,
    });
  });

  it("seed していないテナントは null を返す", async () => {
    const store = new InMemoryTenantCcConfigStore({ seedTenantIds: ["demo"] });
    expect(await store.getTenantCcConfig("missing")).toBeNull();
  });

  it("オプション省略時は空 (どの tenant も null)", async () => {
    const store = new InMemoryTenantCcConfigStore();
    expect(await store.getTenantCcConfig("demo")).toBeNull();
  });

  it("updateTenantCcConfig で notificationCcEmails / enabled が反映される (progressReportEnabled は未送信で既存値保持)", async () => {
    const store = new InMemoryTenantCcConfigStore({ seedTenantIds: ["demo"] });
    await store.updateTenantCcConfig("demo", {
      notificationCcEmails: ["cc1@example.com", "cc2@example.com"],
      completionNotificationEnabled: false,
    });
    expect(await store.getTenantCcConfig("demo")).toEqual({
      ownerEmail: null,
      notificationCcEmails: ["cc1@example.com", "cc2@example.com"],
      completionNotificationEnabled: false,
      // seed の default false がそのまま保たれる
      progressReportEnabled: false,
    });
  });

  it("seed していない tenant への update は新規 config を作る (progressReportEnabled は default false)", async () => {
    const store = new InMemoryTenantCcConfigStore();
    await store.updateTenantCcConfig("new-tenant", {
      notificationCcEmails: ["cc@example.com"],
      completionNotificationEnabled: true,
    });
    expect(await store.getTenantCcConfig("new-tenant")).toEqual({
      ownerEmail: null,
      notificationCcEmails: ["cc@example.com"],
      completionNotificationEnabled: true,
      progressReportEnabled: false,
    });
  });

  // ============================================================
  // Phase 3 ADR-039 D-6: InMemoryTenantCcConfigStore patch semantics
  // ============================================================

  it("updateTenantCcConfig で progressReportEnabled を true に切替できる", async () => {
    const store = new InMemoryTenantCcConfigStore({ seedTenantIds: ["demo"] });
    await store.updateTenantCcConfig("demo", {
      notificationCcEmails: [],
      completionNotificationEnabled: true,
      progressReportEnabled: true,
    });
    const config = await store.getTenantCcConfig("demo");
    expect(config?.progressReportEnabled).toBe(true);
  });

  it("progressReportEnabled=true 保存後に未送信 update を呼ぶと true を保持する (patch semantics)", async () => {
    const store = new InMemoryTenantCcConfigStore({ seedTenantIds: ["demo"] });
    await store.updateTenantCcConfig("demo", {
      notificationCcEmails: [],
      completionNotificationEnabled: true,
      progressReportEnabled: true,
    });
    await store.updateTenantCcConfig("demo", {
      notificationCcEmails: ["cc@example.com"],
      completionNotificationEnabled: false,
      // progressReportEnabled 未送信
    });
    const config = await store.getTenantCcConfig("demo");
    expect(config?.completionNotificationEnabled).toBe(false);
    expect(config?.progressReportEnabled).toBe(true);
  });
});

describe("parseSeedTenantIds (env パース)", () => {
  it("undefined → 空配列", () => {
    expect(parseSeedTenantIds(undefined)).toEqual([]);
  });

  it("空文字 → 空配列", () => {
    expect(parseSeedTenantIds("")).toEqual([]);
  });

  it("単一値", () => {
    expect(parseSeedTenantIds("demo")).toEqual(["demo"]);
  });

  it("カンマ区切り複数値", () => {
    expect(parseSeedTenantIds("demo,tenant-a")).toEqual(["demo", "tenant-a"]);
  });

  it("各要素を trim する", () => {
    expect(parseSeedTenantIds(" demo , tenant-a ")).toEqual([
      "demo",
      "tenant-a",
    ]);
  });

  it("空文字エントリ (連続カンマ・末尾カンマ) を除去する", () => {
    expect(parseSeedTenantIds(",,demo,,tenant-a,")).toEqual([
      "demo",
      "tenant-a",
    ]);
  });

  it("空白のみのエントリも除去する", () => {
    expect(parseSeedTenantIds("demo,   ,tenant-a")).toEqual([
      "demo",
      "tenant-a",
    ]);
  });
});
