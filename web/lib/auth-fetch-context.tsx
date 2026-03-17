"use client";

import { createContext, useContext, useCallback, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useTenantOptional } from "@/lib/tenant-context";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";

type AuthFetchFunction = <T>(path: string, options?: RequestInit) => Promise<T>;

const AuthFetchContext = createContext<AuthFetchFunction | null>(null);

/**
 * 認証付きフェッチ関数を提供するプロバイダー
 * 子コンポーネントでuseAuthFetchを使用可能にする
 *
 * テナントコンテキスト配下の場合:
 *   /admin/* → /api/v2/:tenant/admin/*
 *
 * テナントコンテキスト外の場合:
 *   /api/v1/* をそのまま使用
 */
export function AuthFetchProvider({ children }: { children: ReactNode }) {
  const { getIdToken, isDemo: authIsDemo } = useAuth();
  const tenant = useTenantOptional();

  const authFetch = useCallback(
    async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
      // テナントIDの決定
      const tenantId = tenant?.tenantId ?? (authIsDemo ? "demo" : null);
      const isDemo = tenant?.isDemo ?? authIsDemo;

      let actualPath = path;

      // パス変換ロジック
      if (tenantId) {
        if (path.startsWith("/api/v1/demo/")) {
          actualPath = path.replace("/api/v1/demo/", `/api/v2/${tenantId}/`);
        } else if (path.startsWith("/api/v1/")) {
          actualPath = path.replace("/api/v1/", `/api/v2/${tenantId}/`);
        } else if (path.startsWith("/api/v2/")) {
          actualPath = path;
        } else if (
          path.startsWith("/admin/") ||
          path.startsWith("/courses/") ||
          path.startsWith("/lessons/") ||
          path.startsWith("/users/") ||
          path.startsWith("/auth/") ||
          path.startsWith("/enrollments/") ||
          path.startsWith("/allowed-emails/") ||
          path.startsWith("/analytics/")
        ) {
          // 相対APIパス → テナント付きパス
          actualPath = `/api/v2/${tenantId}${path}`;
        }
      }

      // デモモードではトークン不要
      if (isDemo) {
        return apiFetch<T>(actualPath, options);
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
    [getIdToken, tenant, authIsDemo]
  );

  return (
    <AuthFetchContext.Provider value={authFetch}>
      {children}
    </AuthFetchContext.Provider>
  );
}

/**
 * 認証付きフェッチ関数を取得するフック
 */
export function useAuthFetch(): AuthFetchFunction {
  const context = useContext(AuthFetchContext);
  if (!context) {
    throw new Error("useAuthFetch must be used within an AuthFetchProvider");
  }
  return context;
}
