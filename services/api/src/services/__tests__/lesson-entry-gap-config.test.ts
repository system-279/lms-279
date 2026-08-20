import { describe, it, expect, afterEach, vi } from "vitest";

describe("LESSON_ENTRY_GAP_MS env var override", () => {
  const original = process.env.LESSON_ENTRY_GAP_MS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LESSON_ENTRY_GAP_MS;
    } else {
      process.env.LESSON_ENTRY_GAP_MS = original;
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function loadModule() {
    vi.resetModules();
    return await import("../lesson-session.js");
  }

  it("falls back to default 60000ms (1分) when env var is not set", async () => {
    delete process.env.LESSON_ENTRY_GAP_MS;
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("respects LESSON_ENTRY_GAP_MS env var override", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "30000";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(30000);
  });

  it("accepts 0 as kill switch (disables the feature, unlike SESSION_DURATION_MS)", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "0";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(0);
  });

  it("falls back to default when env var is non-numeric", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "not-a-number";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is empty string", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is whitespace only", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "   ";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is negative", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "-1000";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is non-integer float", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "60000.5";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("accepts a large positive integer (no upper cap by design)", async () => {
    process.env.LESSON_ENTRY_GAP_MS = String(5 * 60 * 1000); // 5min
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(5 * 60 * 1000);
  });

  it("logs error when env var is invalid (observability)", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "abc";
    vi.resetModules();
    const loggerMod = await import("../../utils/logger.js");
    const spy = vi.spyOn(loggerMod.logger, "error").mockImplementation(() => loggerMod.logger);
    await import("../lesson-session.js");
    expect(spy).toHaveBeenCalledWith(
      "Invalid env duration, falling back to default",
      expect.objectContaining({
        envName: "LESSON_ENTRY_GAP_MS",
        rawValue: "abc",
        errorId: "ENV_DURATION_INVALID",
      })
    );
  });
});
