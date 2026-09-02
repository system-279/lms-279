import { createHash } from "node:crypto";

/**
 * エラーの同一性判定に使う fingerprint を計算する。
 * エラー名 + スタック先頭フレーム + 正規化メッセージ から sha256 を取る。
 */
export function computeFingerprint(
  errorName: string,
  firstStackFrame: string,
  normalizedMessage: string
): string {
  return createHash("sha256")
    .update(`${errorName}|${firstStackFrame}|${normalizedMessage}`)
    .digest("hex");
}

/** メッセージ中の可変値（数値・UUID）を潰し、似たメッセージを同一 fingerprint に丸める */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d+/g, "<n>")
    .trim();
}
