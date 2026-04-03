"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CircleHelp } from "lucide-react";
import { TenantProvider, useTenant } from "@/lib/tenant-context";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { AuthFetchProvider, useAuthFetch } from "@/lib/auth-fetch-context";

type UserRole = "admin" | "teacher" | "student" | null;

interface AuthMeResponse {
  user?: { role?: string };
  isSuperAdminAccess?: boolean;
  tenantName?: string;
}

/**
 * ナビゲーションコンポーネント
 * 現在のページパスとユーザーロールに基づいてリンクを表示
 */
function TenantNav({ isSuperAdminAccess }: { isSuperAdminAccess: boolean }) {
  const { tenantId, isDemo } = useTenant();
  const { user, loading: authLoading } = useAuth();
  const authFetch = useAuthFetch();
  const pathname = usePathname();
  const [role, setRole] = useState<UserRole>(null);
  const [loading, setLoading] = useState(true);

  // 現在のパスが管理画面かどうか
  const isOnAdminPage = pathname?.includes(`/${tenantId}/admin`);

  useEffect(() => {
    // 認証中または未ログインの場合はスキップ
    if (authLoading) return;
    if (!user && !isDemo) {
      setLoading(false);
      return;
    }

    // ユーザー情報を取得してロールを設定
    const fetchUserRole = async () => {
      try {
        const data = await authFetch<AuthMeResponse>("/auth/me");
        setRole((data.user?.role as UserRole) ?? "student");
      } catch {
        // エラー時はstudent扱い
        setRole("student");
      } finally {
        setLoading(false);
      }
    };

    fetchUserRole();
  }, [authFetch, user, authLoading, isDemo]);

  const isAdmin = role === "admin" || isSuperAdminAccess;

  // ナビリンクを決定
  // - 管理画面にいる場合: 「受講者向け」を表示
  // - 受講者画面にいる場合: 管理者のみ「管理者向け」を表示
  const showLink = !loading && (isOnAdminPage || isAdmin);
  const linkHref = isOnAdminPage ? `/${tenantId}/student` : `/${tenantId}/admin`;
  const linkText = isOnAdminPage ? "受講者向け" : "管理者向け";

  return (
    <nav className="flex gap-4 text-sm">
      {showLink && (
        <>
          <span className="text-muted-foreground">|</span>
          <Link
            href={linkHref}
            className="text-muted-foreground hover:text-foreground font-medium"
          >
            {linkText}
          </Link>
        </>
      )}
    </nav>
  );
}

/**
 * テナントレイアウトの内部コンポーネント
 * TenantProvider配下でuseTenantを使用
 */
function TenantLayoutInner({ children }: { children: React.ReactNode }) {
  const { tenantId, isDemo } = useTenant();
  const { user, loading: authLoading } = useAuth();
  const authFetch = useAuthFetch();
  const [isSuperAdminAccess, setIsSuperAdminAccess] = useState(false);
  const [tenantName, setTenantName] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;

    const checkSuperAdminAccess = async () => {
      try {
        const data = await authFetch<AuthMeResponse>("/auth/me");
        setIsSuperAdminAccess(data.isSuperAdminAccess ?? false);
        if (data.tenantName) setTenantName(data.tenantName);
      } catch {
        setIsSuperAdminAccess(false);
      }
    };

    checkSuperAdminAccess();
  }, [authFetch, user, authLoading]);

  return (
    <div className="min-h-screen bg-background">
      {/* スーパー管理者アクセスバナー */}
      {isSuperAdminAccess && (
        <div className="bg-red-100 border-b border-red-300 text-red-800 text-center py-2 text-sm">
          スーパー管理者としてアクセス中 -{" "}
          <Link href="/super-admin" className="underline font-medium">
            スーパー管理画面に戻る
          </Link>
        </div>
      )}
      {/* デモモードバナー */}
      {isDemo && (
        <div className="bg-yellow-100 border-b border-yellow-300 text-yellow-800 text-center py-2 text-sm">
          デモモード（読み取り専用） - データの閲覧のみ可能です
        </div>
      )}
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link
            href={`/${tenantId}`}
            className={`font-semibold ${isDemo ? "text-blue-600" : ""}`}
          >
            介護DX college２７９Classroom{isDemo ? " (DEMO)" : ""}
          </Link>
          {tenantName && (
            <span className="text-sm text-muted-foreground border-l pl-4">
              {tenantName}
            </span>
          )}
          <TenantNav isSuperAdminAccess={isSuperAdminAccess} />
          <div className="ml-auto">
            <Link
              href="/help"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition"
            >
              <CircleHelp className="size-4" />
              <span className="hidden sm:inline">ヘルプ</span>
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">{children}</main>
    </div>
  );
}

/**
 * テナント対応レイアウト
 * URLパスからテナントIDを抽出し、TenantProviderで子コンポーネントをラップ
 */
export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const tenantId = (params?.tenant as string) ?? "demo";

  // TenantProvider 配下で AuthProvider/AuthFetchProvider を再ラップすることで、
  // - AuthProvider: isDemo を TenantContext から取得できる
  // - AuthFetchProvider: tenantId を含むAPIパス変換が正しく機能する
  return (
    <TenantProvider tenantId={tenantId}>
      <AuthProvider>
        <AuthFetchProvider>
          <TenantLayoutInner>{children}</TenantLayoutInner>
        </AuthFetchProvider>
      </AuthProvider>
    </TenantProvider>
  );
}
