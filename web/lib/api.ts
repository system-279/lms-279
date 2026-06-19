// 本番環境のAPI URL（Cloud Run）
const PRODUCTION_API_URL = "https://api-3zcica5euq-an.a.run.app";

// 環境変数またはデフォルト値を使用
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? PRODUCTION_API_URL
    : "http://localhost:8080");
const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";
const DEV_USER_ID = process.env.NEXT_PUBLIC_USER_ID ?? "admin-dev";
const DEV_USER_ROLE = process.env.NEXT_PUBLIC_USER_ROLE ?? "admin";

/**
 * BE のエラー body から code / message / details を堅牢に抽出する。
 *
 * 想定する形式:
 *  - ADR-010 flat 形式 (推奨): `{ error: "code_string", message: "...", details?: {...} }`
 *  - 旧 errorHandler nested 形式: `{ error: { code: "...", message: "..." } }`
 *  - レスポンスが JSON parse 不能 (HTML 500 等): `{}` を受け取り fallback
 *
 * `[object Object]` を絶対に画面に出さないため string 強制 + fallback を実装する。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractErrorCode(body: unknown): string {
  if (!isRecord(body)) return "unknown_error";
  const flat = asTrimmedString(body.error);
  if (flat) return flat;
  if (isRecord(body.error)) {
    const nested = asTrimmedString(body.error.code);
    if (nested) return nested;
  }
  return "unknown_error";
}

function extractErrorMessage(body: unknown, status: number): string | undefined {
  if (!isRecord(body)) return undefined;
  const flat = asTrimmedString(body.message);
  if (flat) return flat;
  if (isRecord(body.error)) {
    const nested = asTrimmedString(body.error.message);
    if (nested) return nested;
  }
  // 500/502/503/504 等のサーバー側障害は専用文言で fallback
  if (status >= 500) return `サーバーエラー (HTTP ${status})。再度お試しください。`;
  return undefined;
}

function extractErrorDetails(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.details)) return body.details;
  return undefined;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: Record<string, unknown>
  ) {
    // 2026-06-19 本番障害: BE 側 errorHandler (nested) と apiFetch (flat) の形式
    // 不整合により body.message が非文字列で渡り、Error の super() で `[object Object]`
    // 化していた。constructor 側で runtime 防御し、表示用 fallback を強制する。
    const safeMessage =
      typeof message === "string" && message.trim()
        ? message
        : typeof code === "string" && code.trim()
          ? code
          : `サーバーエラー (HTTP ${status})。再度お試しください。`;
    super(safeMessage);
    this.name = "ApiError";
  }
}

export type UserContext = {
  userId: string;
  role: "admin" | "teacher" | "student";
};

type ApiFetchOptions = RequestInit & {
  /** Firebase認証モード時のIDトークン */
  idToken?: string;
};

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
  userContext?: UserContext
): Promise<T> {
  const { idToken, ...fetchOptions } = options;
  const userId = userContext?.userId ?? DEV_USER_ID;
  const userRole = userContext?.role ?? DEV_USER_ROLE;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(AUTH_MODE === "dev" && {
      // 開発用疑似認証
      "X-User-Id": userId,
      "X-User-Role": userRole,
    }),
    ...(AUTH_MODE === "firebase" && idToken && {
      // Firebase認証
      Authorization: `Bearer ${idToken}`,
    }),
    ...fetchOptions.headers,
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers });
  } catch {
    throw new ApiError(0, "network_error", "ネットワークエラーが発生しました");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as unknown));
    throw new ApiError(
      res.status,
      extractErrorCode(body),
      extractErrorMessage(body, res.status),
      extractErrorDetails(body),
    );
  }

  const text = await res.text();
  return text ? JSON.parse(text) : ({} as T);
}

/**
 * 認証付きAPIフェッチ用ヘルパー
 * useAuth().getIdToken()で取得したトークンを渡す
 */
export function createAuthenticatedFetcher(getIdToken: () => Promise<string | null>) {
  return async function authenticatedFetch<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const idToken = await getIdToken();

    // Firebase認証モードでトークンがない場合はエラー
    if (AUTH_MODE === "firebase" && !idToken) {
      throw new Error("認証トークンを取得できませんでした。再ログインしてください。");
    }

    return apiFetch<T>(path, { ...options, idToken: idToken ?? undefined });
  };
}
