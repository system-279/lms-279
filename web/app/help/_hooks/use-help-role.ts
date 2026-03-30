"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { apiFetch } from "@/lib/api";

export type HelpLevel = "student" | "admin" | "super";

/**
 * ヘルプページ用ロール判定フック
 * Firebase認証 + API呼び出しでヘルプアクセスレベルを判定
 */
export function useHelpRole(): {
  helpLevel: HelpLevel;
  loading: boolean;
} {
  const { user, loading: authLoading, getIdToken } = useAuth();
  const [helpLevel, setHelpLevel] = useState<HelpLevel>("student");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      setHelpLevel("student");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchHelpRole() {
      try {
        const idToken = await getIdToken();
        const data = await apiFetch<{ helpLevel: HelpLevel }>(
          "/api/v2/help/role",
          {
            ...(idToken && {
              headers: { Authorization: `Bearer ${idToken}` },
            }),
          }
        );
        if (!cancelled) {
          setHelpLevel(data.helpLevel);
        }
      } catch {
        // エラー時はstudentレベル
        if (!cancelled) {
          setHelpLevel("student");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchHelpRole();
    return () => { cancelled = true; };
  }, [user, authLoading, getIdToken]);

  return { helpLevel, loading };
}
