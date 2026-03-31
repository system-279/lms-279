import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
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
        PAUSE_TIMEOUT_MS: "5000",
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
