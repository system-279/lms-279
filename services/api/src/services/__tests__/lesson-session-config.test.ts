import { describe, it, expect, afterEach, vi } from "vitest";

describe("SESSION_DURATION_MS env var override", () => {
  const original = process.env.SESSION_DURATION_MS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SESSION_DURATION_MS;
    } else {
      process.env.SESSION_DURATION_MS = original;
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function loadModule() {
    vi.resetModules();
    return await import("../lesson-session.js");
  }

  it("falls back to default 2 hours when env var is not set", async () => {
    delete process.env.SESSION_DURATION_MS;
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("respects SESSION_DURATION_MS env var (3 hours)", async () => {
    process.env.SESSION_DURATION_MS = String(3 * 60 * 60 * 1000);
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("falls back to default when env var is non-numeric", async () => {
    process.env.SESSION_DURATION_MS = "not-a-number";
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("falls back to default when env var is empty string", async () => {
    process.env.SESSION_DURATION_MS = "";
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("falls back to default when env var is whitespace only", async () => {
    process.env.SESSION_DURATION_MS = "   ";
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("falls back to default when env var is zero", async () => {
    process.env.SESSION_DURATION_MS = "0";
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("falls back to default when env var is negative (prevents deadline-in-past)", async () => {
    process.env.SESSION_DURATION_MS = "-1000";
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("falls back to default when env var is non-integer float", async () => {
    process.env.SESSION_DURATION_MS = "7200000.5";
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("accepts very large positive integer (no upper cap by design)", async () => {
    process.env.SESSION_DURATION_MS = String(24 * 60 * 60 * 1000); // 24h
    const mod = await loadModule();
    expect(mod.SESSION_DURATION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("logs error when env var is invalid (observability)", async () => {
    process.env.SESSION_DURATION_MS = "abc";
    // logger を先に import + spy してから lesson-session を import する。
    // spy 対象と env-config 経由で参照される logger を同一インスタンスにするため、
    // resetModules はこの test 冒頭の 1 回のみ。
    vi.resetModules();
    const loggerMod = await import("../../utils/logger.js");
    const spy = vi.spyOn(loggerMod.logger, "error").mockImplementation(() => loggerMod.logger);
    await import("../lesson-session.js");
    expect(spy).toHaveBeenCalledWith(
      "Invalid env duration, falling back to default",
      expect.objectContaining({
        envName: "SESSION_DURATION_MS",
        rawValue: "abc",
        errorId: "ENV_DURATION_INVALID",
      })
    );
  });
});
