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
  });

  it("falls back to default 2 hours when env var is not set", async () => {
    delete process.env.SESSION_DURATION_MS;
    vi.resetModules();
    const mod = await import("../lesson-session.js");
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("respects SESSION_DURATION_MS env var (3 hours)", async () => {
    process.env.SESSION_DURATION_MS = String(3 * 60 * 60 * 1000);
    vi.resetModules();
    const mod = await import("../lesson-session.js");
    expect(mod.SESSION_DURATION_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("falls back to default when env var is non-numeric", async () => {
    process.env.SESSION_DURATION_MS = "not-a-number";
    vi.resetModules();
    const mod = await import("../lesson-session.js");
    expect(mod.SESSION_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });
});
