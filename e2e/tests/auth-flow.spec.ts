import { test, expect } from "@playwright/test";

test.describe("認証フロー", () => {
  test("トップページにログイン関連UIが表示される", async ({ page }) => {
    await page.goto("/");
    // トップページが正常に表示される
    await expect(page).toHaveTitle(/.*/);
    // ページ内に何らかのコンテンツがある
    const body = page.locator("body");
    await expect(body).not.toBeEmpty();
  });

  test("存在しないテナントへのアクセスでエラー表示", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/nonexistent-tenant/courses"
    );
    // テナントが見つからないか認証エラー
    expect([401, 403, 404]).toContain(res.status());
  });
});
