import { test, expect } from "@playwright/test";

test.describe("受講者コース閲覧", () => {
  test("受講者ページURLが存在する", async ({ page }) => {
    const res = await page.goto("/demo/student/courses");
    // ページ自体は存在する（認証リダイレクトも含む）
    expect(res?.status()).toBeLessThan(500);
  });

  test("受講者コースAPIが認証なしで401を返す", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/demo/courses"
    );
    expect([401, 403]).toContain(res.status());
  });
});
