import { test, expect } from "@playwright/test";

test.describe("ヘルスチェック", () => {
  test("API /health が200を返す", async ({ request }) => {
    const res = await request.get("http://localhost:8080/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("Web トップページが200を返す", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
  });
});
