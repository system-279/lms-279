import { describe, it, expect, vi, afterEach } from "vitest";
import { parseBooleanEnv, parseNonNegativeDurationMs } from "../env-config.js";
import { logger } from "../logger.js";

describe("parseBooleanEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to default when env var is undefined", () => {
    expect(parseBooleanEnv(undefined, true, "TEST_FLAG")).toBe(true);
    expect(parseBooleanEnv(undefined, false, "TEST_FLAG")).toBe(false);
  });

  it("falls back to default when env var is empty string", () => {
    expect(parseBooleanEnv("", true, "TEST_FLAG")).toBe(true);
  });

  it("falls back to default when env var is whitespace only", () => {
    expect(parseBooleanEnv("   ", false, "TEST_FLAG")).toBe(false);
  });

  it("parses 'true' as true", () => {
    expect(parseBooleanEnv("true", false, "TEST_FLAG")).toBe(true);
  });

  it("parses 'false' as false", () => {
    expect(parseBooleanEnv("false", true, "TEST_FLAG")).toBe(false);
  });

  it("falls back to default when env var is an invalid value", () => {
    expect(parseBooleanEnv("yes", true, "TEST_FLAG")).toBe(true);
    expect(parseBooleanEnv("1", false, "TEST_FLAG")).toBe(false);
  });

  it("logs error when env var is invalid (observability)", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    parseBooleanEnv("maybe", true, "TEST_FLAG");
    expect(spy).toHaveBeenCalledWith(
      "Invalid env boolean, falling back to default",
      expect.objectContaining({
        envName: "TEST_FLAG",
        rawValue: "maybe",
        defaultValue: true,
        errorId: "ENV_BOOLEAN_INVALID",
      })
    );
  });

  it("does not log when env var is undefined or valid", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    parseBooleanEnv(undefined, true, "TEST_FLAG");
    parseBooleanEnv("true", true, "TEST_FLAG");
    parseBooleanEnv("false", true, "TEST_FLAG");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("parseNonNegativeDurationMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to default when env var is undefined", () => {
    expect(parseNonNegativeDurationMs(undefined, 60000, "TEST_MS")).toBe(60000);
  });

  it("falls back to default when env var is empty/whitespace", () => {
    expect(parseNonNegativeDurationMs("", 60000, "TEST_MS")).toBe(60000);
    expect(parseNonNegativeDurationMs("   ", 60000, "TEST_MS")).toBe(60000);
  });

  it("accepts 0 (kill switch, unlike parsePositiveDurationMs)", () => {
    expect(parseNonNegativeDurationMs("0", 60000, "TEST_MS")).toBe(0);
  });

  it("accepts a positive integer", () => {
    expect(parseNonNegativeDurationMs("60000", 0, "TEST_MS")).toBe(60000);
  });

  it("falls back to default when env var is negative", () => {
    expect(parseNonNegativeDurationMs("-1", 60000, "TEST_MS")).toBe(60000);
  });

  it("falls back to default when env var is non-integer float", () => {
    expect(parseNonNegativeDurationMs("60000.5", 60000, "TEST_MS")).toBe(60000);
  });

  it("falls back to default when env var is non-numeric", () => {
    expect(parseNonNegativeDurationMs("abc", 60000, "TEST_MS")).toBe(60000);
  });

  it("logs error when env var is invalid (observability)", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    parseNonNegativeDurationMs("abc", 60000, "TEST_MS");
    expect(spy).toHaveBeenCalledWith(
      "Invalid env duration, falling back to default",
      expect.objectContaining({
        envName: "TEST_MS",
        rawValue: "abc",
        defaultMs: 60000,
        errorId: "ENV_DURATION_INVALID",
      })
    );
  });

  it("does not log when env var is 0, positive, or undefined", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    parseNonNegativeDurationMs("0", 60000, "TEST_MS");
    parseNonNegativeDurationMs("60000", 0, "TEST_MS");
    parseNonNegativeDurationMs(undefined, 60000, "TEST_MS");
    expect(spy).not.toHaveBeenCalled();
  });
});
