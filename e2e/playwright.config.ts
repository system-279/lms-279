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
