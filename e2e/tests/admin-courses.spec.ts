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

  test("非デモテナントはヘッダなしで401を返す", async ({ request }) => {
    // devモード: ヘッダなし → req.user未設定 → requireAdmin → 401
    const res = await request.get(
      "http://localhost:8080/api/v2/nonexistent-tenant/admin/courses"
    );
    expect(res.status()).toBe(401);
  });

  test("管理画面URLが200を返す", async ({ page }) => {
    const res = await page.goto("/demo/admin/courses");
    expect(res?.status()).toBe(200);
  });
});
