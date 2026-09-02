/**
 * Google Chat へ転送してよいフィールドの allowlist 整形 + PII マスク。
 *
 * 設計方針（運用通知自動化プラン クロスレビュー High #3 反映）:
 *   出口の正規表現マスクのみでは「PII を含めない」を保証できない。
 *   このモジュールは各ハンドラから渡された「型で決まったフィールドのみ」を組み立てる
 *   ことで、任意の metadata や URL クエリ全体が紛れ込む経路そのものを断つ。
 *   その上で、許可されたフィールドの中身（message / stack）に対しても maskPii を通し、
 *   二重に防御する。
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_DIGIT_RE = /\d{9,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi;

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local[0] ?? "*";
  return `${visible}***@${domain}`;
}

/** メールアドレス・Bearerトークン・長い数字列(電話番号等)をマスクする */
export function maskPii(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(BEARER_RE, "Bearer ***")
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(LONG_DIGIT_RE, (m) => `${m.slice(0, 2)}***${m.slice(-2)}`);
}

/** URL からクエリ文字列を除去する（クエリに PII が乗る可能性を遮断） */
export function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

/** `/api/v2/:tenant/...` 形式の path から tenant ID を抽出する（無ければ undefined） */
export function extractTenantId(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const match = /^\/api\/v2\/([^/]+)\//.exec(path);
  if (!match) return undefined;
  const tenantId = match[1];
  if (tenantId === "public" || tenantId === "super" || tenantId === "demo") {
    return undefined;
  }
  return tenantId;
}

/** スタックトレースの先頭 n フレームを返す（改行区切り、前後空白を除去） */
export function topStackFrames(stack: string | undefined, n: number): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(0, n)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface ErrorAlertInput {
  timestamp: string;
  errorName: string;
  message: string;
  method?: string;
  path?: string;
  tenantId?: string;
  stackFrames: string[];
  loggingLink?: string;
  suppressedSincePrevious?: number;
}

export function buildErrorAlertText(input: ErrorAlertInput): string {
  const lines: string[] = [`🔴 [api] ${input.errorName}`, `時刻: ${input.timestamp}`];
  if (input.method && input.path) {
    lines.push(`${input.method} ${input.path}`);
  }
  if (input.tenantId) {
    lines.push(`tenant: ${input.tenantId}`);
  }
  lines.push(`message: ${maskPii(input.message)}`);
  if (input.stackFrames.length > 0) {
    lines.push("stack:");
    for (const frame of input.stackFrames) {
      lines.push(maskPii(frame));
    }
  }
  if (input.suppressedSincePrevious && input.suppressedSincePrevious > 0) {
    lines.push(`（前ウィンドウで${input.suppressedSincePrevious}件抑制）`);
  }
  if (input.loggingLink) {
    lines.push(`Cloud Logging: ${input.loggingLink}`);
  }
  return lines.join("\n");
}

export interface HealthReportInput {
  date: string;
  status: "ok" | "degraded" | "error";
  firestoreStatus: string;
  heapUsedMB?: number;
  detail?: string;
}

export function buildHealthReportText(input: HealthReportInput): string {
  const icon = input.status === "ok" ? "✅" : input.status === "degraded" ? "⚠️" : "🔴";
  const lines = [`${icon} LMS 稼働確認 (${input.date})`, `firestore: ${input.firestoreStatus}`];
  if (typeof input.heapUsedMB === "number") {
    lines.push(`heapUsed: ${input.heapUsedMB}MB`);
  }
  if (input.detail) {
    lines.push(maskPii(input.detail));
  }
  return lines.join("\n");
}

export interface AvailabilityAlertInput {
  state: string;
  policyName: string;
  summary: string;
  url?: string;
}

export function buildAvailabilityAlertText(input: AvailabilityAlertInput): string {
  const icon = input.state === "OPEN" ? "🔴" : "✅";
  const lines = [
    `${icon} 可用性アラート: ${input.policyName}`,
    `状態: ${input.state}`,
    maskPii(input.summary),
  ];
  if (input.url) {
    lines.push(`詳細: ${input.url}`);
  }
  return lines.join("\n");
}

export function buildFlushSummaryText(fingerprintLabel: string, suppressedCount: number): string {
  return [
    `🔁 集約サマリー`,
    `${fingerprintLabel}`,
    `直近ウィンドウで ${suppressedCount} 件抑制されました（新規発生がなかったため個別投稿は行われていません）`,
  ].join("\n");
}
