"use client";

import Link from "next/link";
import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSuperAdminFetch } from "@/lib/super-api";
import { ApiError } from "@/lib/api";
import type {
  TenantStatus,
  SuperTenantDetailResponse,
} from "@lms-279/shared-types";

function StatusBadge({ status }: { status: TenantStatus }) {
  if (status === "active") {
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200">
        有効
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-100 text-red-800 border-red-200">
      停止中
    </Badge>
  );
}

export default function SuperTenantDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { superFetch } = useSuperAdminFetch();
  const superFetchRef = useRef(superFetch);
  superFetchRef.current = superFetch;

  const [data, setData] = useState<SuperTenantDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchDetail() {
      setLoading(true);
      setError(null);
      try {
        const result = await superFetchRef.current<SuperTenantDetailResponse>(
          `/api/v2/super/tenants/${id}`,
        );
        if (!cancelled) setData(result);
      } catch (e) {
        console.error("[SuperTenantDetailPage] Failed to fetch detail:", e);
        if (!cancelled) {
          if (e instanceof ApiError) {
            if (e.status === 404) {
              setError("テナントが見つかりません。");
            } else {
              setError(e.message || "テナント詳細の取得に失敗しました");
            }
          } else {
            setError("テナント詳細の取得に失敗しました");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDetail();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return <div className="text-muted-foreground">読み込み中...</div>;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
        <Link href="/super/tenants">
          <Button variant="outline">一覧に戻る</Button>
        </Link>
      </div>
    );
  }

  if (!data) return null;

  const { tenant, stats } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tenant.name}</h1>
          <p className="text-sm text-muted-foreground mt-1 font-mono">
            ID: {tenant.id}
          </p>
        </div>
        <Link href="/super/tenants">
          <Button variant="outline">一覧に戻る</Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-md border p-4 space-y-3">
          <h2 className="text-lg font-semibold">基本情報</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">オーナーメール</dt>
              <dd>{tenant.ownerEmail}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">オーナーID</dt>
              <dd className="font-mono text-xs">
                {tenant.ownerId || <span className="text-muted-foreground">未設定</span>}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">ステータス</dt>
              <dd><StatusBadge status={tenant.status} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">作成日</dt>
              <dd>
                {tenant.createdAt
                  ? new Date(tenant.createdAt).toLocaleString("ja-JP")
                  : "-"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">更新日</dt>
              <dd>
                {tenant.updatedAt
                  ? new Date(tenant.updatedAt).toLocaleString("ja-JP")
                  : "-"}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-md border p-4 space-y-3">
          <h2 className="text-lg font-semibold">統計</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">ユーザー数</dt>
              <dd className="font-semibold">{stats.userCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">コース数</dt>
              <dd className="font-semibold">{stats.courseCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">レッスン数</dt>
              <dd className="font-semibold">{stats.lessonCount}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
