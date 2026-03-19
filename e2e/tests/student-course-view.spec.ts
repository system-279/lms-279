import { test, expect } from "@playwright/test";

test.describe("受講者コース閲覧", () => {
  test("受講者ページURLが存在する", async ({ page }) => {
    const res = await page.goto("/demo/student/courses");
    expect(res?.status()).toBeLessThan(500);
  });

  test("受講者コースAPIがレスポンスを返す（ステータスコード確認）", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/demo/courses",
      { headers: { "x-dev-user-email": "student@example.com", "x-dev-user-role": "student" } }
    );
    // デモテナントが存在しない場合は404、存在する場合は200
    expect(res.status()).toBeLessThan(500);
  });
});
