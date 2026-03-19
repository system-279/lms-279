import { test, expect } from "@playwright/test";

test.describe("受講者コース閲覧", () => {
  test("受講者ページが200を返す", async ({ page }) => {
    const res = await page.goto("/demo/student/courses");
    expect(res?.status()).toBe(200);
  });

  test("デモテナントの受講者コースAPIが200とcoursesを返す", async ({ request }) => {
    const res = await request.get(
      "http://localhost:8080/api/v2/demo/courses"
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("courses");
    expect(Array.isArray(body.courses)).toBe(true);
  });
});
