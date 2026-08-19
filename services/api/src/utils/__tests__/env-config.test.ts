import { describe, it, expect, vi, afterEach } from "vitest";
import { parseBooleanEnv } from "../env-config.js";
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
