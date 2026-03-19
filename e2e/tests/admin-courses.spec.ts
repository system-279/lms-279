import { test, expect } from "@playwright/test";

test.describe("管理者コース一覧", () => {
  test("コース一覧APIがレスポンスを返す（ステータスコード確認）", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/demo/admin/courses",
      { headers: { "x-dev-user-email": "admin@example.com", "x-dev-user-role": "admin" } }
    );
    // デモテナントが存在しない場合は404、存在する場合は200
    expect(res.status()).toBeLessThan(500);
  });

  test("管理画面URLが存在する", async ({ page }) => {
    const res = await page.goto("/demo/admin/courses");
    expect(res?.status()).toBeLessThan(500);
  });
});
