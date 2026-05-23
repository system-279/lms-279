import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Issue #308 (PR #355) で CI 1 req 当たり 9 秒の Firestore lookup 遅延を解消。
  // PR #307 で暫定 180 秒に拡大した test timeout を本来の 60 秒に戻す。
  // webServer.timeout (60000) は起動タイムアウトで据え置き — test timeout と意図的な差分。
  timeout: 60000,
  retries: 1,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm run start -w @lms-279/api",
      url: "http://localhost:8080/health",
      cwd: "..",
      reuseExistingServer: true,
      timeout: 60000,
      env: {
        AUTH_MODE: "dev",
        PORT: "8080",
        E2E_TEST_ENABLED: "true",
        // dispatch-settings-api.spec で super-admin emulation を有効化
        // (X-User-Email: admin@example.com を super として認識させる)
        SUPER_ADMIN_EMAILS: "admin@example.com",
        // dispatch factory を in-memory モードで mount し、CI で Firestore credential 不要にする。
        // 本番 GCP runtime (K_SERVICE 等) では factory が throw して silent fallback を防ぐ。
        DISPATCH_USE_IN_MEMORY: "true",
        // in-memory モード時の env (factory.ts IN_MEMORY_DEFAULTS と整合、実送信は発生しない)
        DXCOLLEGE_SENDER_EMAIL: "in-memory-from@example.invalid",
        DXCOLLEGE_DISPATCH_SUBJECT: "in-memory-subject@example.invalid",
        DISPATCH_OIDC_AUDIENCE: "https://in-memory.example.invalid",
        // dispatch-settings-api.spec が demo tenant の CC 取得を期待するため seed する
        DISPATCH_IN_MEMORY_SEED_TENANTS: "demo",
      },
    },
    {
      command: "npm run dev -w @lms-279/web",
      url: "http://localhost:3000",
      cwd: "..",
      reuseExistingServer: true,
      timeout: 60000,
    },
  ],
});
