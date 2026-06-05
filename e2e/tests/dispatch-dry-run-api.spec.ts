/**
 * dispatch dry-run API E2E (Phase 4 α-7、OQ #17 #12)。
 *
 * 検証対象: AC-α7-05 (super-admin authentication boundary)
 *   - GET /api/v2/super/dispatch/dry-run/{progress,completion}
 *   - X-User-Email 未指定 → 401
 *   - 非 super email → 403
 *
 * 共有 fixture: e2e/playwright.config.ts の webServer env (DISPATCH_USE_IN_MEMORY=true /
 * SUPER_ADMIN_EMAILS=admin@example.com / DISPATCH_IN_MEMORY_SEED_TENANTS=demo) を活用。
 *
 * 関連:
 *   - 設計仕様書: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §5 AC-α7-05
 *   - route 実装: services/api/src/routes/super/dispatch-dry-run.ts
 *   - 集約 Issue: #521 (OQ #17 #12)
 *   - 戦略 B (ハイブリッド) 採用根拠: rules/testing.md (E2E 致命的導線のみ) +
 *     既存 e2e/dispatch-settings-api.spec.ts の制約 (AUTH_MODE=dev で super UI 遷移不可)、
 *     Session 64 で開発者承認
 *
 * 補足:
 *   - AC-α7-05 の 200 OK 正常応答 (super-admin 認証通過後) は本 spec に含めない:
 *     - dispatch-dry-run route 経路で in-memory wiring 下でも Firestore Query を発火する
 *       依存があり、E2E webServer (in-memory mode) で 500 PERMISSION_DENIED が出る
 *     - 200 OK + body shape は既存 BE integration test
 *       (services/api/src/routes/super/__tests__/dispatch-dry-run.test.ts) で
 *       direct app mount + InMemoryTenantDataLoader seed 経路で網羅済
 *     - E2E 200 化は OQ #17 follow-up (in-memory wiring 調査) として記録
 *   - AC-α7-12 BE 側 (limiter 429 / single-flight) は既存 BE integration test
 *     (dispatch-dry-run.test.ts L349) でカバー済のため E2E 重複なし
 *   - AC-α7-06 read-only 保証は service-level test
 *     (services/api/src/services/dispatch/dry-run/__tests__/) でカバー
 */

import { expect, test } from "@playwright/test";

const API = "http://localhost:8080";
const NON_SUPER_HEADERS = { "X-User-Email": "user@example.com" };

test.describe("dispatch dry-run API 認可境界 (AC-α7-05)", () => {
  for (const lane of ["progress", "completion"] as const) {
    test.describe(`${lane} lane`, () => {
      const path = `/api/v2/super/dispatch/dry-run/${lane}`;

      test(`X-User-Email 未指定で ${path} は 401`, async ({ request }) => {
        const res = await request.get(`${API}${path}`);
        expect(res.status()).toBe(401);
      });

      test(`非 super email で ${path} は 403`, async ({ request }) => {
        const res = await request.get(`${API}${path}`, {
          headers: NON_SUPER_HEADERS,
        });
        expect(res.status()).toBe(403);
      });
    });
  }
});
