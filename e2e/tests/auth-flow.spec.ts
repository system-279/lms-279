import { test, expect } from "@playwright/test";

test.describe("認証フロー", () => {
  test("トップページが200で表示される", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/.+/);
  });

  test("非デモテナントはヘッダなしで401を返す", async ({ request }) => {
    // devモード: ヘッダなし → req.user未設定 → requireUser → 401
    const res = await request.get(
      "http://localhost:8080/api/v2/nonexistent-tenant/courses"
    );
    expect(res.status()).toBe(401);
  });
});
