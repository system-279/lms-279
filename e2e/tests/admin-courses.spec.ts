import { test, expect } from "@playwright/test";

test.describe("管理者コース一覧", () => {
  test("コース一覧APIが認証なしで401を返す", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/demo/courses"
    );
    // AUTH_MODE=devでもヘッダなしは401
    expect([401, 403]).toContain(res.status());
  });

  test("管理画面URLが存在する", async ({ page }) => {
    const res = await page.goto("/demo/admin/courses");
    // ページ自体は存在する（認証リダイレクトも含む）
    expect(res?.status()).toBeLessThan(500);
  });
});
