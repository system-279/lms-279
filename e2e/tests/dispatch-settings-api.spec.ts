/**
 * dispatch-settings (完了通知 配信設定) の API smoke E2E (Phase 6 PR-F2)。
 *
 * dispatch-settings ページは super 全体が Firebase user 必須で、AUTH_MODE=dev かつ
 * user=null では web 側で表示されない (PR-F1 / handoff 既述)。よって本 E2E は UI 遷移を
 * 含まず API 疎通 (`X-User-Email` での super-admin emulation) のみで impl-plan Phase 6
 * 完了条件をカバーする。UI 操作の検証は component test 側で実施
 * (`web/app/super/dispatch-settings/components/__tests__/`)。
 *
 * 確認内容:
 *   - 認可境界: super なし 401 / 非 super 403 / super 200
 *   - audit-logs / runs の正常応答
 *   - tenant notification CC の GET/PUT、エラー応答 (CRLF / 11 件)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * E2E wiring 復旧 (PR #482 の一時 skip を解除、2026-05-23):
 *
 * `e2e/playwright.config.ts` で `DISPATCH_USE_IN_MEMORY=true` +
 * `DISPATCH_IN_MEMORY_SEED_TENANTS=demo` 等を inject し、CI でも Firestore
 * credential なしで dispatch-super-router を mount + demo tenant の CC を
 * read/write できる状態にした。`index.ts` 側で in-memory モード時のみ
 * `InMemoryTenantCcConfigStore` を ccStore として inject している
 * (本番 GCP runtime では factory が throw して silent fallback を防ぐ)。
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

import { test, expect } from "@playwright/test";

const API = "http://localhost:8080";
const SUPER_HEADERS = { "X-User-Email": "admin@example.com" };
const NON_SUPER_HEADERS = { "X-User-Email": "user@example.com" };

test.describe("dispatch super API 認可境界", () => {
  test("X-User-Email 未指定は 401 (audit-logs)", async ({ request }) => {
    const res = await request.get(`${API}/api/v2/super/dispatch/audit-logs`);
    expect(res.status()).toBe(401);
  });

  test("非 super email は 403 (audit-logs)", async ({ request }) => {
    const res = await request.get(`${API}/api/v2/super/dispatch/audit-logs`, {
      headers: NON_SUPER_HEADERS,
    });
    expect(res.status()).toBe(403);
  });

  test("非 super email は 403 (runs)", async ({ request }) => {
    const res = await request.get(`${API}/api/v2/super/dispatch/runs`, {
      headers: NON_SUPER_HEADERS,
    });
    expect(res.status()).toBe(403);
  });

  test("super-admin emulation で audit-logs は 200", async ({ request }) => {
    const res = await request.get(`${API}/api/v2/super/dispatch/audit-logs`, {
      headers: SUPER_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("logs");
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body).toHaveProperty("nextCursor");
  });

  test("super-admin emulation で runs は 200", async ({ request }) => {
    const res = await request.get(`${API}/api/v2/super/dispatch/runs`, {
      headers: SUPER_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("runs");
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body).toHaveProperty("nextCursor");
  });
});

test.describe("tenant notification CC API", () => {
  test("non-super email でアクセスすると 403", async ({ request }) => {
    const res = await request.get(
      `${API}/api/v2/super/tenants/demo/notification-cc-emails`,
      { headers: NON_SUPER_HEADERS },
    );
    expect(res.status()).toBe(403);
  });

  test("super-admin で demo tenant の CC 取得 → 200 + 期待スキーマ", async ({
    request,
  }) => {
    const res = await request.get(
      `${API}/api/v2/super/tenants/demo/notification-cc-emails`,
      { headers: SUPER_HEADERS },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ownerEmail");
    expect(body).toHaveProperty("notificationCcEmails");
    expect(Array.isArray(body.notificationCcEmails)).toBe(true);
    expect(body).toHaveProperty("completionNotificationEnabled");
    expect(typeof body.completionNotificationEnabled).toBe("boolean");
  });

  test("PUT で CC 配列と enabled を更新できる (再 GET で反映確認)", async ({
    request,
  }) => {
    const newEmails = [`cc-${Date.now()}@example.com`];
    const putRes = await request.put(
      `${API}/api/v2/super/tenants/demo/notification-cc-emails`,
      {
        headers: SUPER_HEADERS,
        data: {
          notificationCcEmails: newEmails,
          completionNotificationEnabled: true,
        },
      },
    );
    expect(putRes.status()).toBe(200);
    const updated = await putRes.json();
    expect(updated.notificationCcEmails).toEqual(newEmails);
    expect(updated.completionNotificationEnabled).toBe(true);

    // 再 GET で反映確認
    const getRes = await request.get(
      `${API}/api/v2/super/tenants/demo/notification-cc-emails`,
      { headers: SUPER_HEADERS },
    );
    expect(getRes.status()).toBe(200);
    const reread = await getRes.json();
    expect(reread.notificationCcEmails).toEqual(newEmails);
  });

  test("PUT で CRLF を含む CC は 400 invalid_cc_emails", async ({ request }) => {
    const res = await request.put(
      `${API}/api/v2/super/tenants/demo/notification-cc-emails`,
      {
        headers: SUPER_HEADERS,
        data: {
          notificationCcEmails: ["foo\r\nbar@example.com"],
          completionNotificationEnabled: true,
        },
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_cc_emails");
  });

  test("PUT で 11 件以上の CC は 400 cc_emails_too_many", async ({ request }) => {
    const tooMany = Array.from(
      { length: 11 },
      (_, i) => `cc${i}@example.com`,
    );
    const res = await request.put(
      `${API}/api/v2/super/tenants/demo/notification-cc-emails`,
      {
        headers: SUPER_HEADERS,
        data: {
          notificationCcEmails: tooMany,
          completionNotificationEnabled: true,
        },
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cc_emails_too_many");
  });
});
