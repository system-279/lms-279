import { test, expect } from "@playwright/test";

test.describe("管理者コース一覧", () => {
  test("デモテナントのコース一覧APIが200とcoursesを返す", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/demo/admin/courses"
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("courses");
    expect(Array.isArray(body.courses)).toBe(true);
  });

  test("存在しないテナントは認証エラーを返す", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/nonexistent-tenant/admin/courses"
    );
    expect([401, 403]).toContain(res.status());
  });

  test("管理画面URLが200を返す", async ({ page }) => {
    const res = await page.goto("/demo/admin/courses");
    expect(res?.status()).toBe(200);
  });
});
