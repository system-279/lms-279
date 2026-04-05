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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useAuth } from "@/lib/auth-context";

type UserRole = "admin" | "student";

type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
};

export default function UsersPage() {
  const { authFetch } = useAuthenticatedFetch();
  const { user: currentUser } = useAuth();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Role update (inline)
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createRole, setCreateRole] = useState<UserRole>("student");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // CSV import dialog
  const [importOpen, setImportOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    summary: { total: number; created: number; skipped: number; errors: number };
    created: { email: string; name: string | null; role: string }[];
    skipped: { email: string; reason: string }[];
    errors: { line: number; email?: string; reason: string }[];
  } | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<{ users: User[] }>("/api/v1/admin/users");
      setUsers(data.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ユーザーの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreate = async () => {
    if (!createName.trim() || !createEmail.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await authFetch("/api/v1/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName.trim(),
          email: createEmail.trim(),
          role: createRole,
        }),
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateEmail("");
      setCreateRole("student");
      fetchUsers();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreateLoading(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    const prev = users.find((u) => u.id === userId);
    if (!prev || prev.role === newRole) return;

    // Optimistic update
    setUsers((us) => us.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
    setUpdatingRoleId(userId);
    try {
      await authFetch(`/api/v1/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
    } catch (e) {
      // Rollback
      setUsers((us) => us.map((u) => (u.id === userId ? { ...u, role: prev.role } : u)));
      setError(e instanceof Error ? e.message : "ロールの変更に失敗しました");
    } finally {
      setUpdatingRoleId(null);
    }
  };

  const openDelete = (user: User) => {
    setDeletingUser(user);
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const handleCsvImport = async (file: File) => {
    setImportLoading(true);
    setImportError(null);
    setImportResult(null);
    try {
      const csv = await file.text();
      const data = await authFetch<typeof importResult>("/api/v1/admin/users/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      setImportResult(data);
      if (data && data.summary.created > 0) {
        fetchUsers();
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "インポートに失敗しました");
    } finally {
      setImportLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingUser) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await authFetch(`/api/v1/admin/users/${deletingUser.id}`, {
        method: "DELETE",
      });
      setDeleteOpen(false);
      setDeletingUser(null);
      fetchUsers();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">ユーザー管理</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setImportError(null);
              setImportResult(null);
              setImportOpen(true);
            }}
          >
            CSVインポート
          </Button>
          <Button
            onClick={() => {
              setCreateName("");
              setCreateEmail("");
              setCreateRole("student");
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            新規作成
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : users.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          データがありません
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>メール</TableHead>
              <TableHead>ロール</TableHead>
              <TableHead>作成日</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Select
                    value={user.role}
                    onValueChange={(v) => handleRoleChange(user.id, v as UserRole)}
                    disabled={updatingRoleId === user.id || user.email === currentUser?.email}
                  >
                    <SelectTrigger className="w-[100px] h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="student">受講者</SelectItem>
                      <SelectItem value="admin">管理者</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  {new Date(user.createdAt).toLocaleDateString("ja-JP")}
                </TableCell>
                <TableCell>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => openDelete(user)}
                  >
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* 作成ダイアログ */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ユーザーを作成</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">名前</label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="氏名を入力"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">メールアドレス</label>
              <Input
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                placeholder="email@example.com"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">ロール</label>
              <Select value={createRole} onValueChange={(v) => setCreateRole(v as UserRole)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="student">受講者</SelectItem>
                  <SelectItem value="admin">管理者</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {createError && (
              <div className="text-sm text-destructive">{createError}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createLoading || !createName.trim() || !createEmail.trim()}
            >
              {createLoading ? "作成中..." : "作成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 削除確認ダイアログ */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ユーザーを削除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            「{deletingUser?.name}」({deletingUser?.email}) を削除しますか？この操作は取り消せません。
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
      {/* CSVインポートダイアログ */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>CSVインポート</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              CSV形式: <code>email,name,role</code>（ヘッダー行必須、name/roleは任意）
              <br />
              <span className="text-xs">※ 値にカンマや改行を含めないでください。上限500行。</span>
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              className="block w-full text-sm file:mr-4 file:rounded file:border-0 file:bg-primary/10 file:px-4 file:py-2 file:text-sm file:font-medium hover:file:bg-primary/20"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleCsvImport(file);
              }}
              disabled={importLoading}
            />
            {importLoading && (
              <div className="text-sm text-muted-foreground">インポート中...</div>
            )}
            {importError && (
              <div className="text-sm text-destructive">{importError}</div>
            )}
            {importResult && (
              <div className="space-y-2 text-sm">
                <div className="rounded-md bg-muted p-3 space-y-1">
                  <div>合計: {importResult.summary.total}件</div>
                  <div className="text-green-600">作成: {importResult.summary.created}件</div>
                  <div className="text-yellow-600">スキップ: {importResult.summary.skipped}件</div>
                  <div className="text-destructive">エラー: {importResult.summary.errors}件</div>
                </div>
                {importResult.errors.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-destructive">エラー詳細</summary>
                    <ul className="mt-1 space-y-0.5 pl-4">
                      {importResult.errors.map((err, i) => (
                        <li key={i}>行{err.line}: {err.email ?? "不明"} — {err.reason}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {importResult.skipped.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-yellow-600">スキップ詳細</summary>
                    <ul className="mt-1 space-y-0.5 pl-4">
                      {importResult.skipped.map((s, i) => (
                        <li key={i}>{s.email} — 既存ユーザー</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              閉じる
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
