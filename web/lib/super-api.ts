"use client";

import { useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";
const DEV_SUPER_ADMIN_EMAIL =
  process.env.NEXT_PUBLIC_SUPER_ADMIN_EMAIL ?? "admin@example.com";

/**
 * スーパー管理者用APIフェッチフック
 * テナントコンテキスト外で使用する（useAuthenticatedFetch は使わない）
 */
export function useSuperAdminFetch() {
  const { getIdToken } = useAuth();

  const superFetch = useCallback(
    async <T>(path: string, options: RequestInit = {}): Promise<T> => {
      const idToken =
        AUTH_MODE === "firebase" ? await getIdToken() : null;

      return apiFetch<T>(path, {
        ...options,
        ...(idToken ? { idToken } : {}),
        headers: {
          ...options.headers,
          ...(AUTH_MODE === "dev" && {
            "X-User-Email": DEV_SUPER_ADMIN_EMAIL,
          }),
        },
      });
    },
    [getIdToken],
  );

  return { superFetch };
}
