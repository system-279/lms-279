"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { addMonths, addYears } from "date-fns";
import { useSuperAdminFetch } from "@/lib/super-api";
import type { TenantEnrollmentSettingResponse } from "@lms-279/shared-types";

type Tenant = { id: string; name: string };

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function isExpired(dateStr: string): boolean {
  return new Date(dateStr) < new Date();
}

export default function EnrollmentsPage() {
  const { superFetch } = useSuperAdminFetch();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState("");
  const [setting, setSetting] = useState<TenantEnrollmentSettingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 設定ダイアログ
  const [settingOpen, setSettingOpen] = useState(false);
  const [settingEnrolledAt, setSettingEnrolledAt] = useState("");
  const [settingDeadlineBaseDate, setSettingDeadlineBaseDate] = useState("");
  const [settingLoading, setSettingLoading] = useState(false);

  // テナント一覧取得
  useEffect(() => {
    superFetch<{ tenants: Tenant[] }>("/api/v2/super/tenants?limit=100")
      .then((data) => setTenants(data.tenants))
      .catch(() => {});
  }, [superFetch]);

  // 設定取得
  const fetchSetting = useCallback(async () => {
    if (!selectedTenant) return;
    setLoading(true);
    setError(null);
    try {
      const data = await superFetch<{ setting: TenantEnrollmentSettingResponse | null }>(
        `/api/v2/super/tenants/${selectedTenant}/enrollment-setting`
      );
      setSetting(data.setting);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedTenant, superFetch]);

  useEffect(() => {
    if (selectedTenant) {
      fetchSetting();
    } else {
      setSetting(null);
    }
  }, [selectedTenant, fetchSetting]);

  // 設定保存
  const handleSave = async () => {
    if (!selectedTenant || !settingEnrolledAt) return;
    // 起算日が受講開始日より後の場合はクライアント側で早期ガード
    if (
      settingDeadlineBaseDate &&
      !isNaN(new Date(settingDeadlineBaseDate).getTime()) &&
      new Date(settingDeadlineBaseDate) > new Date(settingEnrolledAt)
    ) {
      setError("期限起算日は受講開始日以前の日付を指定してください");
      return;
    }
    setSettingLoading(true);
    try {
      const body: { enrolledAt: string; deadlineBaseDate?: string } = {
        enrolledAt: new Date(settingEnrolledAt).toISOString(),
      };
      if (settingDeadlineBaseDate) {
        body.deadlineBaseDate = new Date(settingDeadlineBaseDate).toISOString();
      }
      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/enrollment-setting`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      setSettingOpen(false);
      fetchSetting();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSettingLoading(false);
    }
  };

  // 設定削除
  const handleDelete = async () => {
    if (!confirm("受講期間設定を削除しますか？\n削除するとこのテナントの受講期間制限が解除されます。")) return;
    try {
      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/enrollment-setting`,
        { method: "DELETE" }
      );
      fetchSetting();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  // 設定ダイアログを開く
  const openSettingDialog = () => {
    setSettingEnrolledAt(setting?.enrolledAt?.split("T")[0] ?? "");
    setSettingDeadlineBaseDate(setting?.deadlineBaseDate?.split("T")[0] ?? "");
    setSettingOpen(true);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">受講期間管理</h2>
      <p className="text-sm text-muted-foreground">
        テナント単位で受講期間を設定します。テスト期限（+2ヶ月）と動画期限（+1年）は受講開始日から自動計算されます。期限は日本時間の日末（23:59）まで有効です。
      </p>

      {/* テナント選択 */}
      <div className="w-64">
        <label className="text-sm text-muted-foreground">テナント</label>
        <Select value={selectedTenant} onValueChange={setSelectedTenant}>
          <SelectTrigger><SelectValue placeholder="テナント選択" /></SelectTrigger>
          <SelectContent>
            {tenants.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : !selectedTenant ? (
        <p className="text-muted-foreground">テナントを選択してください</p>
      ) : setting ? (
        <div className="rounded-md border p-6 space-y-3 max-w-lg">
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <span className="text-muted-foreground">受講開始日</span>
            <span>{formatDate(setting.enrolledAt)}</span>
            {setting.deadlineBaseDate && (
              <>
                <span className="text-muted-foreground">期限起算日</span>
                <span>{formatDate(setting.deadlineBaseDate)}</span>
              </>
            )}
            <span className="text-muted-foreground">テスト期限</span>
            <span className={isExpired(setting.quizAccessUntil) ? "text-destructive font-medium" : ""}>
              {formatDate(setting.quizAccessUntil)}
              {isExpired(setting.quizAccessUntil) && " (期限切れ)"}
            </span>
            <span className="text-muted-foreground">動画期限</span>
            <span className={isExpired(setting.videoAccessUntil) ? "text-destructive font-medium" : ""}>
              {formatDate(setting.videoAccessUntil)}
              {isExpired(setting.videoAccessUntil) && " (期限切れ)"}
            </span>
            <span className="text-muted-foreground">設定者</span>
            <span className="text-xs">{setting.createdBy}</span>
          </div>
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={openSettingDialog}>変更</Button>
            <Button size="sm" variant="outline" className="text-destructive" onClick={handleDelete}>削除</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground">受講期間が設定されていません</p>
          <Button onClick={openSettingDialog}>受講期間を設定</Button>
        </div>
      )}

      {/* 設定ダイアログ */}
      <Dialog open={settingOpen} onOpenChange={setSettingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>受講期間を設定</DialogTitle>
            <DialogDescription>
              テナントの受講開始日を設定します。テスト期限（+2ヶ月）と動画期限（+1年）は自動計算されます。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm">受講開始日</label>
              <Input
                type="date"
                value={settingEnrolledAt}
                onChange={(e) => setSettingEnrolledAt(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm">期限起算日（任意）</label>
              <Input
                type="date"
                value={settingDeadlineBaseDate}
                max={settingEnrolledAt || undefined}
                onChange={(e) => setSettingDeadlineBaseDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                未入力時は受講開始日から起算します。受講開始日は変更されません。受講開始日以前の日付のみ指定可能です。
              </p>
            </div>
            {settingEnrolledAt && !isNaN(new Date(settingEnrolledAt).getTime()) && (() => {
              const baseDateStr = settingDeadlineBaseDate && !isNaN(new Date(settingDeadlineBaseDate).getTime())
                ? settingDeadlineBaseDate
                : settingEnrolledAt;
              const baseDate = new Date(baseDateStr);
              const baseLabel = settingDeadlineBaseDate ? "期限起算日" : "受講開始日";
              return (
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>テスト期限: {formatDate(addMonths(baseDate, 2).toISOString())}（{baseLabel} +2ヶ月、JST 23:59まで有効）</p>
                  <p>動画期限: {formatDate(addYears(baseDate, 1).toISOString())}（{baseLabel} +1年、JST 23:59まで有効）</p>
                </div>
              );
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingOpen(false)}>キャンセル</Button>
            <Button onClick={handleSave} disabled={settingLoading || !settingEnrolledAt}>
              {settingLoading ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
