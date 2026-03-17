import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useTenantOptional } from "@/lib/tenant-context";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";

type FetchOptions = RequestInit;

/**
 * 認証付きAPIフェッチフック
 * Firebase認証モードの場合、自動的にIDトークンを付与する
 *
 * TenantContext配下の場合:
 *   /api/v1/* → /api/v2/:tenant/* に変換
 *
 * テナントコンテキスト外の場合:
 *   デモモード: /api/v1/* → /api/v1/demo/* に変換（後方互換性）
 *   通常: /api/v1/* をそのまま使用
 */
export function useAuthenticatedFetch() {
  const router = useRouter();
  const { user, loading: authLoading, getIdToken, isDemo: authIsDemo } = useAuth();
  const tenant = useTenantOptional();

  // テナントIDの決定
  const tenantId = tenant?.tenantId ?? (authIsDemo ? "demo" : null);
  const isDemo = tenant?.isDemo ?? authIsDemo;

  const authFetch = useCallback(
    async <T>(path: string, options: FetchOptions = {}): Promise<T> => {
      let actualPath = path;

      // パス変換ロジック
      if (tenantId) {
        // TenantContext配下または後方互換デモモードの場合
        if (path.startsWith("/api/v1/demo/")) {
          // 旧デモAPIパス → 新テナントAPIパス
          actualPath = path.replace("/api/v1/demo/", `/api/v2/${tenantId}/`);
        } else if (path.startsWith("/api/v1/")) {
          // 旧APIパス → 新テナントAPIパス
          actualPath = path.replace("/api/v1/", `/api/v2/${tenantId}/`);
        } else if (path.startsWith("/api/v2/")) {
          // 既に v2 形式ならそのまま
          actualPath = path;
        }
      }

      // デモモードの場合は認証チェックをスキップ
      if (isDemo) {
        return apiFetch<T>(actualPath, options);
      }

      // Firebase認証モードで未認証の場合はホームへリダイレクト
      if (AUTH_MODE === "firebase" && !authLoading && !user) {
        router.push(tenant ? `/${tenant.tenantId}` : "/");
        throw new Error("認証が必要です");
      }

      const idToken = await getIdToken();

      // Firebase認証モードでトークンがない場合はエラー
      if (AUTH_MODE === "firebase" && !idToken) {
        throw new Error("認証トークンを取得できませんでした。再ログインしてください。");
      }

      return apiFetch<T>(actualPath, {
        ...options,
        idToken: idToken ?? undefined,
      });
    },
    [user, authLoading, getIdToken, router, tenantId, isDemo]
  );

  return {
    authFetch,
    user,
    authLoading,
    isAuthenticated: isDemo || AUTH_MODE !== "firebase" || !!user,
    isDemo,
    tenantId,
  };
}
