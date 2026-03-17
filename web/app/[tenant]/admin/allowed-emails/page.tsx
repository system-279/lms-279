"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";

type AllowedEmail = {
  id: string;
  email: string;
  createdAt: string;
};

export default function AllowedEmailsPage() {
  const { authFetch } = useAuthenticatedFetch();

  const [allowedEmails, setAllowedEmails] = useState<AllowedEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form (inline, no dialog needed for simple single-field)
  const [addEmail, setAddEmail] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingEmail, setDeletingEmail] = useState<AllowedEmail | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchAllowedEmails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<{ allowedEmails: AllowedEmail[] }>(
        "/api/v1/admin/allowed-emails"
      );
      setAllowedEmails(data.allowedEmails);
    } catch (e) {
      setError(e instanceof Error ? e.message : "許可メールの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    fetchAllowedEmails();
  }, [fetchAllowedEmails]);

  const handleAdd = async () => {
    if (!addEmail.trim()) return;
    setAddLoading(true);
    setAddError(null);
    try {
      await authFetch("/api/v1/admin/allowed-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addEmail.trim() }),
      });
      setAddEmail("");
      fetchAllowedEmails();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setAddLoading(false);
    }
  };

  const openDelete = (entry: AllowedEmail) => {
    setDeletingEmail(entry);
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingEmail) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await authFetch(`/api/v1/admin/allowed-emails/${deletingEmail.id}`, {
        method: "DELETE",
      });
      setDeleteOpen(false);
      setDeletingEmail(null);
      fetchAllowedEmails();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">許可メール管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          ここに登録されたメールアドレスのみが受講者としてログイン可能です。
        </p>
      </div>

      {/* 追加フォーム */}
      <div className="flex items-end gap-3">
        <div className="flex-1 max-w-sm space-y-1">
          <label className="text-sm font-medium">メールアドレスを追加</label>
          <Input
            type="email"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            placeholder="email@example.com"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
        </div>
        <Button onClick={handleAdd} disabled={addLoading || !addEmail.trim()}>
          {addLoading ? "追加中..." : "追加"}
        </Button>
      </div>

      {addError && (
        <div className="text-sm text-destructive">{addError}</div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : allowedEmails.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          データがありません
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>メールアドレス</TableHead>
              <TableHead>登録日</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allowedEmails.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>{entry.email}</TableCell>
                <TableCell>
                  {new Date(entry.createdAt).toLocaleDateString("ja-JP")}
                </TableCell>
                <TableCell>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => openDelete(entry)}
                  >
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* 削除確認ダイアログ */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>許可メールを削除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            「{deletingEmail?.email}」を削除しますか？この操作は取り消せません。
          </p>
          {deleteError && (
            <div className="text-sm text-destructive">{deleteError}</div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading ? "削除中..." : "削除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
