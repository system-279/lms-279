import { logger } from "./logger.js";

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
