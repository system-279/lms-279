import { test, expect } from "@playwright/test";

test.describe("ヘルスチェック", () => {
  test("API /health が200を返す", async ({ request }) => {
    const res = await request.get("http://localhost:8080/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("API /health/ready がchecksオブジェクトを含むレスポンスを返す", async ({ request }) => {
    const res = await request.get("http://localhost:8080/health/ready");
    // ローカル環境ではFirestore接続状況により200 or 503
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body.checks).toBeDefined();
    expect(body.checks.memory).toBeDefined();
    expect(typeof body.checks.memory.heapUsedMB).toBe("number");
  });

  test("Web トップページが200を返す", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
  });
});
