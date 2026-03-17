"use client";

import Link from "next/link";
import { useTenant } from "@/lib/tenant-context";
import { useAuth } from "@/lib/auth-context";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";

/**
 * テナント対応トップページ
 * Firebase認証モードで未ログインの場合はログイン画面を表示
 * ログイン済みまたはdevモードの場合は管理者・受講者への振り分け
 */
export default function TenantPage() {
  const { tenantId, isDemo } = useTenant();
  const { user, loading, error, signInWithGoogle } = useAuth();

  // Firebase認証モードで未ログインの場合はログイン画面を表示
  if (AUTH_MODE === "firebase" && !isDemo && !user && !loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="rounded-lg border bg-card p-8 text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4">LMS 279</h1>
          <p className="text-muted-foreground mb-6">
            学習管理システムへようこそ。
          </p>
          {error && (
            <p className="text-sm text-red-500 mb-4">{error}</p>
          )}
          <button
            onClick={signInWithGoogle}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors w-full"
          >
            Googleでログイン
          </button>
        </div>
      </div>
    );
  }

  // ローディング中
  if (AUTH_MODE === "firebase" && !isDemo && loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="rounded-lg border bg-card p-8 text-center max-w-md">
          <p className="text-muted-foreground">読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="rounded-lg border bg-card p-8 text-center max-w-md">
        <h1 className="text-2xl font-bold mb-4">
          LMS 279{isDemo ? " (DEMO)" : ""}
        </h1>
        <p className="text-muted-foreground mb-6">
          学習管理システムへようこそ。
        </p>

        <div className="flex flex-col gap-3">
          <Link
            href={`/${tenantId}/student/courses`}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            受講者として学習を開始
          </Link>
          <Link
            href={`/${tenantId}/admin`}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            管理画面
          </Link>
        </div>

        {isDemo && (
          <p className="mt-4 text-xs text-muted-foreground">
            デモモード - データの閲覧のみ可能です
          </p>
        )}
      </div>
    </div>
  );
}
