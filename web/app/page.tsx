"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleHelp } from "lucide-react";
import type { MyTenantInfo, MineTenantsResponse } from "@lms-279/shared-types";
import { useAuth } from "../lib/auth-context";
import { apiFetch } from "../lib/api";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";

export default function HomePage() {
  const router = useRouter();
  const { user, loading, error, signInWithGoogle, signOut, getIdToken } = useAuth();
  const [tenants, setTenants] = useState<MyTenantInfo[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [tenantsError, setTenantsError] = useState<string | null>(null);

  // Firebase認証モードで未ログインの場合はログイン画面を表示
  if (AUTH_MODE === "firebase" && !user && !loading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <section className="rounded-lg border bg-card p-8 text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4">介護DX college２７９Classroom</h1>
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
          <p className="mt-4 pt-4 border-t text-xs text-muted-foreground">
            ログインして開始してください
          </p>
          <Link
            href="/help"
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
          >
            <CircleHelp className="size-3.5" />
            ヘルプ
          </Link>
        </section>
      </main>
    );
  }

  // ローディング中
  if (AUTH_MODE === "firebase" && loading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <section className="rounded-lg border bg-card p-8 text-center max-w-md">
          <p className="text-muted-foreground">読み込み中...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background flex items-center justify-center">
      <section className="rounded-lg border bg-card p-8 text-center max-w-md">
        <h1 className="text-2xl font-bold mb-4">介護DX college２７９Classroom</h1>
        <p className="text-muted-foreground mb-6">
          学習管理システムへようこそ。
        </p>

        {AUTH_MODE === "firebase" && user && (
          <LoggedInView
            user={user}
            signOut={signOut}
            getIdToken={getIdToken}
            router={router}
            tenants={tenants}
            setTenants={setTenants}
            tenantsLoading={tenantsLoading}
            setTenantsLoading={setTenantsLoading}
            tenantsError={tenantsError}
            setTenantsError={setTenantsError}
          />
        )}

        {AUTH_MODE === "dev" && (
          <p className="mt-4 text-xs text-muted-foreground">
            開発モード（認証なし）
          </p>
        )}

        <Link
          href="/help"
          className="mt-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
        >
          <CircleHelp className="size-3.5" />
          ヘルプ
        </Link>
      </section>
    </main>
  );
}

function LoggedInView({
  user,
  signOut,
  getIdToken,
  router,
  tenants,
  setTenants,
  tenantsLoading,
  setTenantsLoading,
  tenantsError,
  setTenantsError,
}: {
  user: { email: string | null };
  signOut: () => void;
  getIdToken: () => Promise<string | null>;
  router: ReturnType<typeof useRouter>;
  tenants: MyTenantInfo[];
  setTenants: (t: MyTenantInfo[]) => void;
  tenantsLoading: boolean;
  setTenantsLoading: (l: boolean) => void;
  tenantsError: string | null;
  setTenantsError: (e: string | null) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    async function fetchTenants() {
      setTenantsLoading(true);
      setTenantsError(null);
      try {
        const idToken = await getIdToken();
        const data = await apiFetch<MineTenantsResponse>(
          "/api/v2/tenants/mine?status=active",
          { idToken: idToken ?? undefined }
        );
        if (cancelled) return;
        // テナントが1件のみの場合は自動リダイレクト
        if (data.tenants.length === 1) {
          router.push(`/${data.tenants[0].id}`);
          return;
        }
        setTenants(data.tenants);
      } catch (e) {
        if (cancelled) return;
        setTenantsError(
          e instanceof Error ? e.message : "テナント情報の取得に失敗しました"
        );
      } finally {
        if (!cancelled) setTenantsLoading(false);
      }
    }
    fetchTenants();
    return () => { cancelled = true; };
  }, [getIdToken, router, setTenants, setTenantsLoading, setTenantsError]);

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-4">
        ログイン中: {user.email}
      </p>

      {tenantsLoading && (
        <p className="text-sm text-muted-foreground mb-4">テナント情報を読み込み中...</p>
      )}

      {tenantsError && (
        <p className="text-sm text-red-500 mb-4">{tenantsError}</p>
      )}

      {!tenantsLoading && !tenantsError && tenants.length > 1 && (
        <div className="flex flex-col gap-2 mb-4">
          <p className="text-sm font-medium mb-1">所属テナントを選択:</p>
          {tenants.map((t) => (
            <Link
              key={t.id}
              href={`/${t.id}`}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {t.name}
            </Link>
          ))}
        </div>
      )}

      {!tenantsLoading && !tenantsError && tenants.length === 0 && (
        <div className="mb-4">
          <p className="text-sm text-muted-foreground">
            所属するテナントがありません。
            <br />
            管理者にお問い合わせください。
          </p>
        </div>
      )}

      <button
        onClick={signOut}
        className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors w-full"
      >
        ログアウト
      </button>
    </div>
  );
}
