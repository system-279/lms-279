// 本番環境のAPI URL（Cloud Run）
const PRODUCTION_API_URL = "https://api-102013220292.asia-northeast1.run.app";

// 環境変数またはデフォルト値を使用
const API_BASE = process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? PRODUCTION_API_URL
    : "http://localhost:8080");
const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";
const DEV_USER_ID = process.env.NEXT_PUBLIC_USER_ID ?? "admin-dev";
const DEV_USER_ROLE = process.env.NEXT_PUBLIC_USER_ROLE ?? "admin";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: Record<string, unknown>
  ) {
    super(message ?? code);
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
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "unknown_error", body.message, body.details);
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
