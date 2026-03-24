"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useSuperAdminFetch } from "@/lib/super-api";

type SuperAdmin = {
  email: string;
  source: "env" | "firestore";
  addedBy?: string;
  addedAt?: string;
};

export default function SuperAdminSettingsPage() {
  const { superFetch } = useSuperAdminFetch();

  const [admins, setAdmins] = useState<SuperAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [deletingEmail, setDeletingEmail] = useState<string | null>(null);

  const fetchAdmins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await superFetch<{ admins: SuperAdmin[] }>(
        "/api/v2/super/admins"
      );
      setAdmins(data.admins);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [superFetch]);

  useEffect(() => {
    fetchAdmins();
  }, [fetchAdmins]);

  const handleAdd = async () => {
    if (!newEmail.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await superFetch("/api/v2/super/admins", {
        method: "POST",
        body: JSON.stringify({ email: newEmail.trim() }),
      });
      setNewEmail("");
      fetchAdmins();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (email: string) => {
    setDeletingEmail(email);
    try {
      await superFetch(
        `/api/v2/super/admins/${encodeURIComponent(email)}`,
        { method: "DELETE" }
      );
      fetchAdmins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeletingEmail(null);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">スーパー管理者設定</h2>

      {/* 追加フォーム */}
      <div className="rounded-md border p-4 space-y-3">
        <h3 className="text-sm font-semibold">管理者を追加</h3>
        <div className="flex gap-2">
          <Input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="admin@279279.net"
            disabled={adding}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button onClick={handleAdd} disabled={adding || !newEmail.trim()}>
            {adding ? "追加中..." : "追加"}
          </Button>
        </div>
        {addError && (
          <p className="text-sm text-destructive">{addError}</p>
        )}
      </div>

      {/* 一覧 */}
      <div className="rounded-md border">
        <div className="p-4 border-b">
          <h3 className="text-sm font-semibold">
            管理者一覧（{admins.length}件）
          </h3>
        </div>

        {error && (
          <div className="p-4 text-sm text-destructive">{error}</div>
        )}

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">
            読み込み中...
          </div>
        ) : admins.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            スーパー管理者が登録されていません
          </div>
        ) : (
          <div className="divide-y">
            {admins.map((admin) => (
              <div
                key={admin.email}
                className="p-4 flex items-center justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{admin.email}</span>
                    <Badge
                      variant={
                        admin.source === "env" ? "secondary" : "outline"
                      }
                      className="text-xs"
                    >
                      {admin.source === "env" ? "環境変数" : "追加済み"}
                    </Badge>
                  </div>
                  {admin.addedBy && (
                    <p className="text-xs text-muted-foreground">
                      追加者: {admin.addedBy}
                      {admin.addedAt &&
                        ` / ${new Date(admin.addedAt).toLocaleString("ja-JP")}`}
                    </p>
                  )}
                </div>
                {admin.source === "firestore" && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(admin.email)}
                    disabled={deletingEmail === admin.email}
                  >
                    {deletingEmail === admin.email ? "削除中..." : "削除"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
