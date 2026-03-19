import { test, expect } from "@playwright/test";

test.describe("認証フロー", () => {
  test("トップページが200で表示される", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/.+/);
  });

  test("存在しないテナントへのAPI呼び出しは認証エラーを返す", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/nonexistent-tenant/courses"
    );
    // devモード: ヘッダなし→user未設定→401 or 403
    expect([401, 403]).toContain(res.status());
  });
});
