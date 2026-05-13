"use client";

/**
 * スーパー管理者向け 受講者進捗 PDF 出力プレビュー画面 (Phase 1)。
 *
 * - 7 項目チェックボックス（全 ON 初期値）で出力セクションを選択
 * - 「PDF生成」ボタンで POST /api/v2/super/tenants/:tenantId/users/:userId/progress-pdf
 * - レスポンス Blob を a[download] でダウンロード
 * - 宛先 ownerEmail を表示（Phase 2 のメール送信前提として土台を Phase 1 から）
 *
 * 認可は親 super-admin layout が user チェック済、API 側で superAdminAuthMiddleware が動く。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/lib/auth-context";
import { useSuperAdminFetch } from "@/lib/super-api";
import { API_BASE } from "@/lib/api";
import type {
  ProgressPdfSectionKey,
  ProgressPdfSections,
  SuperStudentProgressResponse,
  SuperTenantDetailResponse,
} from "@lms-279/shared-types";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";
const DEV_SUPER_ADMIN_EMAIL =
  process.env.NEXT_PUBLIC_SUPER_ADMIN_EMAIL ?? "admin@example.com";

const SECTION_DEFS: { key: ProgressPdfSectionKey; label: string; description: string }[] = [
  { key: "profile", label: "受講者プロフィール", description: "氏名・メール・テナント・発行日" },
  { key: "deadline", label: "受講期限", description: "受講開始日・期限起算日・動画/テスト期限と残り日数" },
  { key: "summary", label: "進捗サマリー", description: "コースごとの完了レッスン数と進捗率バー" },
  { key: "lessons", label: "レッスン別チェックリスト", description: "全レッスンを完了/未完了マーク付きで一覧" },
  { key: "quiz", label: "テスト成績", description: "レッスンごとの最高得点と合格判定" },
  { key: "pace", label: "推奨ペース", description: "1週間あたりレッスン数・1日あたり視聴時間" },
  { key: "video", label: "動画視聴時間", description: "累計視聴時間と全体長" },
];

const ALL_ON: ProgressPdfSections = {
  profile: true,
  deadline: true,
  summary: true,
  lessons: true,
  quiz: true,
  pace: true,
  video: true,
};

type StudentMeta = {
  userId: string;
  userName: string | null;
  userEmail: string;
  tenantName: string;
};


export default function ProgressPdfPrintPage() {
  const params = useParams<{ tenantId: string; userId: string }>();
  const tenantId = params.tenantId;
  const userId = params.userId;
  const { getIdToken } = useAuth();
  const { superFetch } = useSuperAdminFetch();

  const [sections, setSections] = useState<ProgressPdfSections>(ALL_ON);
  const [meta, setMeta] = useState<StudentMeta | null>(null);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    setLoadingMeta(true);
    setMetaError(null);

    Promise.all([
      superFetch<SuperTenantDetailResponse>(`/api/v2/super/tenants/${tenantId}`),
      superFetch<SuperStudentProgressResponse>(`/api/v2/super/tenants/${tenantId}/student-progress`),
    ])
      .then(([detail, progress]) => {
        if (cancelled) return;
        const student = progress.students.find((s) => s.userId === userId);
        if (!student) {
          setMetaError("対象の受講者がこのテナントに見つかりませんでした。");
          setLoadingMeta(false);
          return;
        }
        setMeta({
          userId: student.userId,
          userName: student.userName,
          userEmail: student.userEmail,
          tenantName: progress.tenantName,
        });
        setOwnerEmail(detail.tenant.ownerEmail || null);
        setLoadingMeta(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "受講者情報の取得に失敗しました。";
        setMetaError(msg);
        setLoadingMeta(false);
      });

    return () => {
      cancelled = true;
    };
  }, [superFetch, tenantId, userId]);

  const toggleSection = useCallback((key: ProgressPdfSectionKey) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const anySelected = useMemo(
    () => SECTION_DEFS.some((d) => sections[d.key]),
    [sections],
  );

  const handleGenerate = useCallback(async () => {
    if (!meta) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const idToken = AUTH_MODE === "firebase" ? await getIdToken() : null;
      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };
      if (AUTH_MODE === "dev") {
        headers["X-User-Email"] = DEV_SUPER_ADMIN_EMAIL;
      }
      if (idToken) {
        headers["Authorization"] = `Bearer ${idToken}`;
      }

      const res = await fetch(
        `${API_BASE}/api/v2/super/tenants/${tenantId}/users/${userId}/progress-pdf`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ requestId, sections }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `PDF 生成に失敗しました (HTTP ${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const filenameSafeName = (meta.userName ?? meta.userEmail).replace(/[^A-Za-z0-9._-]/g, "_");
      const dateStr = new Date().toISOString().slice(0, 10);
      a.download = `progress-${filenameSafeName}-${dateStr}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // 同じ requestId で連投されないよう次回用に発行
      setRequestId(crypto.randomUUID());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "PDF 生成に失敗しました";
      setGenerateError(msg);
    } finally {
      setGenerating(false);
    }
  }, [meta, getIdToken, tenantId, userId, requestId, sections]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/super/progress" className="text-sm text-muted-foreground hover:text-foreground">
          ← 受講状況一覧へ戻る
        </Link>
        <h2 className="text-xl font-bold mt-2">受講進捗 PDF 出力</h2>
      </div>

      {loadingMeta && <p className="text-sm text-muted-foreground">受講者情報を取得中...</p>}
      {metaError && <p className="text-sm text-red-600">{metaError}</p>}

      {meta && (
        <>
          <div className="rounded-md border p-4 space-y-1">
            <div className="text-sm">
              <span className="text-muted-foreground mr-2">受講者:</span>
              {meta.userName ?? "—"}  <span className="text-muted-foreground">({meta.userEmail})</span>
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground mr-2">テナント:</span>
              {meta.tenantName}
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground mr-2">テナント管理者宛先 (Phase 2 用):</span>
              {ownerEmail ?? <span className="text-amber-700">未設定</span>}
            </div>
          </div>

          <div className="rounded-md border p-4 space-y-3">
            <h3 className="font-medium">出力する項目</h3>
            <p className="text-xs text-muted-foreground">
              チェックを外した項目は PDF に含まれません。
            </p>
            <div className="space-y-2">
              {SECTION_DEFS.map((def) => (
                <label key={def.key} className="flex items-start gap-3 cursor-pointer">
                  <Checkbox
                    checked={sections[def.key]}
                    onCheckedChange={() => toggleSection(def.key)}
                    aria-label={def.label}
                  />
                  <div className="text-sm">
                    <div>{def.label}</div>
                    <div className="text-xs text-muted-foreground">{def.description}</div>
                  </div>
                </label>
              ))}
            </div>
            {!anySelected && (
              <p className="text-xs text-amber-700">
                すべての項目がオフです。少なくとも 1 項目を選択することを推奨します。
              </p>
            )}
          </div>

          <div className="flex items-center gap-4">
            <Button onClick={handleGenerate} disabled={generating}>
              {generating ? "生成中..." : "PDF生成"}
            </Button>
            {generateError && <span className="text-sm text-red-600">{generateError}</span>}
          </div>
        </>
      )}
    </div>
  );
}
