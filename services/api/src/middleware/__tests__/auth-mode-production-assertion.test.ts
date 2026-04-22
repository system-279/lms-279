/**
 * 本番誤有効化 fail-safe (Issue #290) の起動時 assertion テスト
 *
 * 対象:
 *   - services/api/src/middleware/tenant-auth.ts
 *   - services/api/src/middleware/super-admin.ts
 *
 * 狙い:
 *   NODE_ENV=production 下で AUTH_MODE が "firebase" でないままモジュールが
 *   ロードされた場合、ヘッダ疑似認証が無検証で信頼され allowed_emails 境界
 *   (ADR-031 Issue #286 / #294) がすべてバイパスされる。これを Cloud Run
 *   起動時に fail-fast で検知するため、モジュールトップレベルで Error を
 *   throw する。開発/テスト環境 (NODE_ENV !== "production") では従来通り
 *   AUTH_MODE=dev でも起動可能であることを保証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Firebase Admin SDK は import されるだけでネットワーク初期化しないようモックする。
vi.mock("firebase-admin/app", () => ({
  getApps: () => [{ name: "[DEFAULT]" }],
  initializeApp: vi.fn(),
  cert: vi.fn(),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(),
}));

describe.each([
  { label: "tenant-auth.ts", modulePath: "../tenant-auth.js" },
  { label: "super-admin.ts", modulePath: "../super-admin.js" },
])("$label production fail-safe (Issue #290)", ({ modulePath }) => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("NODE_ENV=production + AUTH_MODE=dev なら import 時に Error を throw", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "dev");

    await expect(import(modulePath)).rejects.toThrow(
      /AUTH_MODE must be "firebase" in production/
    );
  });

  it("NODE_ENV=production + AUTH_MODE='' (空文字) でも throw", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // vi.stubEnv は undefined 注入ができないため空文字を使用。
    // `?? "dev"` は undefined/null のみフォールバック対象（空文字は通過）なので
    // authMode === "" のまま評価され、"" !== "firebase" で拒否される。
    // つまり本ケースは「AUTH_MODE を明示的に空文字に設定した」IaC ミス相当を
    // 検証しており、Cloud Run で `env.AUTH_MODE.value: ""` が起きても
    // fail-safe が働くことを保証する。
    // ※ 真の未設定 (delete process.env.AUTH_MODE) の場合は authMode が "dev"
    //   にフォールバックし、別テスト（最初のケース "AUTH_MODE=dev"）で同等にカバー。
    vi.stubEnv("AUTH_MODE", "");

    await expect(import(modulePath)).rejects.toThrow(
      /AUTH_MODE must be "firebase" in production/
    );
  });

  it("NODE_ENV=production + AUTH_MODE=firebase は起動成功", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "firebase");

    await expect(import(modulePath)).resolves.toBeDefined();
  });

  it("NODE_ENV=development + AUTH_MODE=dev は起動成功（開発体験保護）", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "dev");

    await expect(import(modulePath)).resolves.toBeDefined();
  });

  it("NODE_ENV=test + AUTH_MODE=dev は起動成功（CI / vitest 既定環境）", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_MODE", "dev");

    await expect(import(modulePath)).resolves.toBeDefined();
  });

  it("NODE_ENV 未設定 + AUTH_MODE=dev は起動成功（production 明示でない限り通す）", async () => {
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("AUTH_MODE", "dev");

    await expect(import(modulePath)).resolves.toBeDefined();
  });
});
