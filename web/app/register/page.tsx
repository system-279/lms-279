"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Tenant = {
  id: string;
  name: string;
};

type CreateTenantResponse = {
  tenant: Tenant;
  adminUrl: string;
  studentUrl: string;
};

// コピー成功時のフィードバック用
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      className="shrink-0"
    >
      {copied ? "コピーしました" : label}
    </Button>
  );
}

// リンク表示コンポーネント
function LinkDisplay({
  label,
  description,
  fullUrl,
}: {
  label: string;
  description: string;
  fullUrl: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-sm">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-background px-3 py-2 text-sm font-mono border truncate">
          {fullUrl}
        </code>
        <CopyButton text={fullUrl} label="コピー" />
      </div>
    </div>
  );
}

// 登録完了画面
function RegistrationComplete({
  tenant,
  adminUrl,
  studentUrl,
}: {
  tenant: Tenant;
  adminUrl: string;
  studentUrl: string;
}) {
  const router = useRouter();

  // フルURLを生成（ハイドレーション後にクライアントサイドで更新）
  const [fullAdminUrl, setFullAdminUrl] = useState(adminUrl);
  const [fullStudentUrl, setFullStudentUrl] = useState(studentUrl);

  useEffect(() => {
    const baseUrl = window.location.origin;
    setFullAdminUrl(`${baseUrl}${adminUrl}`);
    setFullStudentUrl(`${baseUrl}${studentUrl}`);
  }, [adminUrl, studentUrl]);

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="max-w-lg w-full">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg
              className="h-8 w-8 text-green-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <CardTitle className="text-xl">登録が完了しました</CardTitle>
          <CardDescription>
            「{tenant.name}」の準備が整いました
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* リンク一覧 */}
          <div className="space-y-4">
            <LinkDisplay
              label="管理者用リンク"
              description="講座の設定や受講者の管理を行います"
              fullUrl={fullAdminUrl}
            />

            <LinkDisplay
              label="受講者用リンク"
              description="受講者に共有してください"
              fullUrl={fullStudentUrl}
            />
          </div>

          {/* 注意事項 */}
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
            <p className="text-sm text-amber-800">
              <strong>次のステップ:</strong>
            </p>
            <ol className="mt-2 text-sm text-amber-700 list-decimal list-inside space-y-1">
              <li>管理画面で講座を作成</li>
              <li>レッスンを追加</li>
              <li>受講者のメールアドレスを登録</li>
              <li>受講者用リンクを共有</li>
            </ol>
          </div>

          {/* アクションボタン */}
          <div className="flex flex-col gap-3">
            <Button
              onClick={() => router.push(adminUrl)}
              className="w-full"
              size="lg"
            >
              管理画面へ進む
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push("/")}
              className="w-full"
            >
              ホームに戻る
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

export default function RegisterPage() {
  const { user, loading: authLoading, signInWithGoogle, getIdToken } = useAuth();
  const [organizationName, setOrganizationName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 登録完了状態
  const [registrationResult, setRegistrationResult] = useState<{
    tenant: Tenant;
    adminUrl: string;
    studentUrl: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!organizationName.trim()) {
      setError("組織名を入力してください。");
      return;
    }

    if (organizationName.length > 100) {
      setError("組織名は100文字以内で入力してください。");
      return;
    }

    setIsSubmitting(true);

    try {
      const idToken = await getIdToken();
      if (!idToken) {
        setError("認証トークンを取得できませんでした。再ログインしてください。");
        setIsSubmitting(false);
        return;
      }

      const response = await apiFetch<CreateTenantResponse>("/api/v2/tenants", {
        method: "POST",
        body: JSON.stringify({ name: organizationName.trim() }),
        idToken,
      });

      // 完了画面を表示（リダイレクトせず）
      setRegistrationResult({
        tenant: response.tenant,
        adminUrl: response.adminUrl,
        studentUrl: response.studentUrl,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "テナントの作成に失敗しました。再度お試しください。"
      );
      setIsSubmitting(false);
    }
  };

  // 登録完了 → 完了画面を表示
  if (registrationResult) {
    return (
      <RegistrationComplete
        tenant={registrationResult.tenant}
        adminUrl={registrationResult.adminUrl}
        studentUrl={registrationResult.studentUrl}
      />
    );
  }

  // ローディング中
  if (authLoading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">読み込み中...</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  // 未ログイン → ログインを促す
  if (!user) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <CardHeader>
            <CardTitle>新規登録</CardTitle>
            <CardDescription>
              組織を登録するにはGoogleアカウントでログインしてください。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={signInWithGoogle} className="w-full">
              Googleでログイン
            </Button>
            <div className="text-center">
              <Link
                href="/"
                className="text-sm text-muted-foreground hover:text-primary"
              >
                ← ホームに戻る
              </Link>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  // ログイン済み → 登録フォーム
  return (
    <main className="min-h-screen bg-background flex items-center justify-center">
      <Card className="max-w-md w-full mx-4">
        <CardHeader>
          <CardTitle>組織を登録</CardTitle>
          <CardDescription>
            LMS 279を利用する組織を登録します。
            <br />
            登録後、すぐに利用を開始できます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">ログイン中のアカウント</Label>
              <p className="text-sm text-muted-foreground">{user.email}</p>
              <p className="text-xs text-muted-foreground">
                このアカウントが組織の管理者になります。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="organizationName">組織名 *</Label>
              <Input
                id="organizationName"
                type="text"
                placeholder="例: ○○学習塾"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                maxLength={100}
                disabled={isSubmitting}
                required
              />
              <p className="text-xs text-muted-foreground">
                学校、塾、教室などの名前を入力してください（1〜100文字）
              </p>
            </div>

            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "作成中..." : "組織を作成"}
            </Button>

            <div className="text-center pt-2">
              <Link
                href="/"
                className="text-sm text-muted-foreground hover:text-primary"
              >
                ← ホームに戻る
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
