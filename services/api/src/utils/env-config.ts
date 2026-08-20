import { logger } from "./logger.js";

export function parseBooleanEnv(
  raw: string | undefined,
  defaultValue: boolean,
  envName: string
): boolean {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  logger.error("Invalid env boolean, falling back to default", {
    envName,
    rawValue: raw,
    defaultValue,
    errorId: "ENV_BOOLEAN_INVALID",
  });
  return defaultValue;
}

export function parsePositiveDurationMs(
  raw: string | undefined,
  defaultMs: number,
  envName: string
): number {
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    logger.error("Invalid env duration, falling back to default", {
      envName,
      rawValue: raw,
      defaultMs,
      errorId: "ENV_DURATION_INVALID",
    });
    return defaultMs;
  }
  return parsed;
}

/**
 * parsePositiveDurationMs と同一だが `0` を許容する（kill switch 用途）。
 * `0` は「機能無効化」を意味する正当な値であり、不正値ではない。
 */
export function parseNonNegativeDurationMs(
  raw: string | undefined,
  defaultMs: number,
  envName: string
): number {
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    logger.error("Invalid env duration, falling back to default", {
      envName,
      rawValue: raw,
      defaultMs,
      errorId: "ENV_DURATION_INVALID",
    });
    return defaultMs;
  }
  return parsed;
}
