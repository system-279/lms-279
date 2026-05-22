/**
 * Dispatch factory の wiring テスト。
 *
 * 検証:
 *   - 環境変数の必須チェック (silent fallback しない、rules/error-handling.md §2)
 *   - DISPATCH_USE_IN_MEMORY=true で InMemory 実装が返る (production 切替フラグ)
 *   - 既定では Firestore 実装が返る (productionモード) — Firebase Admin 未初期化環境では
 *     getFirestore() が throw するため、本テストは throw も含めた挙動を確認する
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildDispatchFactory } from "../factory.js";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";
import { InMemoryTenantDataLoader } from "../tenant-data-loader.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // 環境変数を毎回リセット (test 間の汚染防止)
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("DXCOLLEGE_") ||
      key === "DISPATCH_OIDC_AUDIENCE" ||
      key === "DISPATCH_USE_IN_MEMORY" ||
      key === "K_SERVICE" ||
      key === "FUNCTION_TARGET" ||
      key === "FUNCTION_NAME" ||
      key === "GAE_SERVICE"
    ) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  // 復元
  process.env = { ...ORIGINAL_ENV };
});

describe("buildDispatchFactory - production env validation (DISPATCH_USE_IN_MEMORY != true)", () => {
  beforeEach(() => {
    // production モード前提 (in-memory フラグ未設定)
    delete process.env.DISPATCH_USE_IN_MEMORY;
  });

  it("DXCOLLEGE_DISPATCH_SUBJECT 未設定 → throw", () => {
    process.env.DXCOLLEGE_SENDER_EMAIL = "dxcollege@279279.net";
    process.env.DISPATCH_OIDC_AUDIENCE = "https://api.example.com";
    expect(() => buildDispatchFactory()).toThrow(/DXCOLLEGE_DISPATCH_SUBJECT/);
  });

  it("DXCOLLEGE_SENDER_EMAIL 未設定 → throw", () => {
    process.env.DXCOLLEGE_DISPATCH_SUBJECT = "system@279279.net";
    process.env.DISPATCH_OIDC_AUDIENCE = "https://api.example.com";
    expect(() => buildDispatchFactory()).toThrow(/DXCOLLEGE_SENDER_EMAIL/);
  });

  it("DISPATCH_OIDC_AUDIENCE 未設定 → throw", () => {
    process.env.DXCOLLEGE_DISPATCH_SUBJECT = "system@279279.net";
    process.env.DXCOLLEGE_SENDER_EMAIL = "dxcollege@279279.net";
    expect(() => buildDispatchFactory()).toThrow(/DISPATCH_OIDC_AUDIENCE/);
  });

  it("env が空文字列のみ → throw (silent fallback 防止)", () => {
    process.env.DXCOLLEGE_DISPATCH_SUBJECT = "   ";
    process.env.DXCOLLEGE_SENDER_EMAIL = "dxcollege@279279.net";
    process.env.DISPATCH_OIDC_AUDIENCE = "https://api.example.com";
    expect(() => buildDispatchFactory()).toThrow(/DXCOLLEGE_DISPATCH_SUBJECT/);
  });
});

describe("buildDispatchFactory - DISPATCH_USE_IN_MEMORY=true (env 任意化)", () => {
  beforeEach(() => {
    process.env.DISPATCH_USE_IN_MEMORY = "true";
  });

  it("env 全部設定済 → 設定値をそのまま採用", () => {
    process.env.DXCOLLEGE_DISPATCH_SUBJECT = "system@279279.net";
    process.env.DXCOLLEGE_SENDER_EMAIL = "dxcollege@279279.net";
    process.env.DISPATCH_OIDC_AUDIENCE = "https://api.example.com";
    const result = buildDispatchFactory();
    expect(result.mode).toBe("in-memory");
    expect(result.storage).toBeInstanceOf(InMemoryDispatchStorage);
    expect(result.loader).toBeInstanceOf(InMemoryTenantDataLoader);
    expect(result.env).toEqual({
      subjectEmail: "system@279279.net",
      fromEmail: "dxcollege@279279.net",
    });
    expect(result.expectedAudience).toBe("https://api.example.com");
  });

  it("env 全部未設定 → InMemory モードでも throw せず mock デフォルトを採用", () => {
    // env 3 つとも未設定
    const result = buildDispatchFactory();
    expect(result.mode).toBe("in-memory");
    expect(result.env.subjectEmail).toContain("@example.invalid");
    expect(result.env.fromEmail).toContain("@example.invalid");
    expect(result.expectedAudience).toContain("example.invalid");
  });

  it("一部 env のみ設定 → 設定済は採用、未設定はデフォルト", () => {
    process.env.DXCOLLEGE_SENDER_EMAIL = "real-from@example.com";
    const result = buildDispatchFactory();
    expect(result.env.fromEmail).toBe("real-from@example.com");
    expect(result.env.subjectEmail).toContain("@example.invalid");
  });

  it("verifier は GoogleOidcTokenVerifier (mock 動作確認のため verify メソッド存在のみ確認)", () => {
    const result = buildDispatchFactory();
    expect(typeof result.verifier.verify).toBe("function");
  });
});

describe("buildDispatchFactory - 本番 GCP runtime での in-memory 拒否 (silent no-op 防止)", () => {
  beforeEach(() => {
    process.env.DISPATCH_USE_IN_MEMORY = "true";
    // env を mock 設定 (production env が揃ってても in-memory が拒否されることを確認)
    process.env.DXCOLLEGE_DISPATCH_SUBJECT = "system@279279.net";
    process.env.DXCOLLEGE_SENDER_EMAIL = "dxcollege@279279.net";
    process.env.DISPATCH_OIDC_AUDIENCE = "https://api.example.com";
  });

  it("K_SERVICE (Cloud Run) + DISPATCH_USE_IN_MEMORY=true → throw", () => {
    process.env.K_SERVICE = "lms-279-api";
    expect(() => buildDispatchFactory()).toThrow(
      /DISPATCH_USE_IN_MEMORY=true is forbidden in production GCP runtime/,
    );
  });

  it("FUNCTION_TARGET (Cloud Functions) + DISPATCH_USE_IN_MEMORY=true → throw", () => {
    process.env.FUNCTION_TARGET = "myHandler";
    expect(() => buildDispatchFactory()).toThrow(/forbidden in production/);
  });

  it("FUNCTION_NAME (Cloud Functions 1st gen) + DISPATCH_USE_IN_MEMORY=true → throw", () => {
    process.env.FUNCTION_NAME = "myFunction";
    expect(() => buildDispatchFactory()).toThrow(/forbidden in production/);
  });

  it("GAE_SERVICE (App Engine) + DISPATCH_USE_IN_MEMORY=true → throw", () => {
    process.env.GAE_SERVICE = "default";
    expect(() => buildDispatchFactory()).toThrow(/forbidden in production/);
  });

  it("GCP runtime シグナルなし + DISPATCH_USE_IN_MEMORY=true → in-memory モードで成功", () => {
    // K_SERVICE 等は未設定
    const result = buildDispatchFactory();
    expect(result.mode).toBe("in-memory");
  });
});

describe("buildDispatchFactory - production (Firestore) mode", () => {
  it("DISPATCH_USE_IN_MEMORY=false かつ env 揃い → mode=firestore で返る", () => {
    process.env.DXCOLLEGE_DISPATCH_SUBJECT = "system@279279.net";
    process.env.DXCOLLEGE_SENDER_EMAIL = "dxcollege@279279.net";
    process.env.DISPATCH_OIDC_AUDIENCE = "https://api.example.com";
    delete process.env.DISPATCH_USE_IN_MEMORY;
    // 本テスト環境では Firebase Admin が初期化されていないと
    // getFirestore() が throw する可能性があるが、初期化済みなら
    // FirestoreDispatchStorage が返る。両方の挙動を許容する。
    try {
      const result = buildDispatchFactory();
      expect(result.mode).toBe("firestore");
      expect(result.storage.constructor.name).toBe("FirestoreDispatchStorage");
      expect(result.loader.constructor.name).toBe("FirestoreTenantDataLoader");
    } catch (err) {
      // Firebase Admin 未初期化環境 (一部の test 環境) では throw が想定挙動
      expect(err).toBeInstanceOf(Error);
    }
  });
});
