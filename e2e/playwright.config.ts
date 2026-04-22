import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // CI の 1 リクエスト当たり 7-9 秒の遅延（Issue #308 で根本調査中）で 60秒は不足。
  // 項目3/7 等のマルチリクエスト test が 60秒を超えて Request context disposed に
  // なるのを回避するため 180秒に拡大。ローカルは fast path で影響なし。
  // webServer.timeout (60000) は起動タイムアウトで据え置き — test timeout と意図的な差分。
  timeout: 180000,
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
