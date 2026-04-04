"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { useSuperAdminFetch } from "@/lib/super-api";

type TenantStatus = "active" | "suspended";

type Tenant = {
  id: string;
  name: string;
  ownerEmail: string;
  status: TenantStatus;
  createdAt: string | null;
  updatedAt: string | null;
};

type TenantListResponse = {
  tenants: Tenant[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

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

export default function SuperTenantsPage() {
  const { superFetch } = useSuperAdminFetch();
  const superFetchRef = useRef(superFetch);
  superFetchRef.current = superFetch;

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [total, setTotal] = useState(0);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editStatus, setEditStatus] = useState<TenantStatus>("active");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingTenant, setDeletingTenant] = useState<Tenant | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const data = await superFetchRef.current<TenantListResponse>(
        `/api/v2/super/tenants${query}`,
      );
      setTenants(data.tenants);
      setTotal(data.pagination.total);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "テナント一覧の取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchTenants();
  }, [fetchTenants]);

  const handleCreate = async () => {
    if (!createName.trim() || !createEmail.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await superFetch("/api/v2/super/tenants", {
        method: "POST",
        body: JSON.stringify({
          name: createName.trim(),
          ownerEmail: createEmail.trim(),
        }),
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateEmail("");
      fetchTenants();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreateLoading(false);
    }
  };

  const openEdit = (tenant: Tenant) => {
    setEditingTenant(tenant);
    setEditName(tenant.name);
    setEditEmail(tenant.ownerEmail);
    setEditStatus(tenant.status);
    setEditError(null);
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editingTenant || !editName.trim()) return;
    setEditLoading(true);
    setEditError(null);
    try {
      await superFetch(
        `/api/v2/super/tenants/${editingTenant.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: editName.trim(),
            ownerEmail: editEmail.trim(),
            status: editStatus,
          }),
        },
      );
      setEditOpen(false);
      setEditingTenant(null);
      fetchTenants();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditLoading(false);
    }
  };

  const openDelete = (tenant: Tenant) => {
    setDeletingTenant(tenant);
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingTenant) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await superFetch(
        `/api/v2/super/tenants/${deletingTenant.id}`,
        { method: "DELETE" },
      );
      setDeleteOpen(false);
      setDeletingTenant(null);
      fetchTenants();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">テナント管理</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {!loading && `${total}件のテナント`}
          </p>
        </div>
        <Button
          onClick={() => {
            setCreateName("");
            setCreateEmail("");
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          新規作成
        </Button>
      </div>

      {/* ステータスフィルタ */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">ステータス:</span>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">すべて</SelectItem>
            <SelectItem value="active">有効</SelectItem>
            <SelectItem value="suspended">停止中</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : tenants.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          テナントがありません
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>組織名</TableHead>
              <TableHead>オーナー</TableHead>
              <TableHead>ステータス</TableHead>
              <TableHead>作成日</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((tenant) => (
              <TableRow key={tenant.id}>
                <TableCell className="font-mono text-xs">
                  {tenant.id}
                </TableCell>
                <TableCell className="font-medium">
                  {tenant.name}
                </TableCell>
                <TableCell className="text-sm">
                  {tenant.ownerEmail}
                </TableCell>
                <TableCell>
                  <StatusBadge status={tenant.status} />
                </TableCell>
                <TableCell>
                  {tenant.createdAt
                    ? new Date(tenant.createdAt).toLocaleDateString("ja-JP")
                    : "-"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(tenant)}
                    >
                      編集
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => openDelete(tenant)}
                    >
                      削除
                    </Button>
                  </div>
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
            <DialogTitle>テナントを作成</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">組織名</label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="例: ○○学習塾"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">オーナーメールアドレス</label>
              <Input
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                placeholder="owner@example.com"
              />
              <p className="text-xs text-muted-foreground">
                このメールアドレスがテナントの管理者になります
              </p>
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

      {/* 編集ダイアログ */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>テナントを編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">テナントID</label>
              <p className="text-sm font-mono text-muted-foreground">
                {editingTenant?.id}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">組織名</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="組織名を入力"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">オーナーメールアドレス</label>
              <Input
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder="owner@example.com"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">ステータス</label>
              <Select value={editStatus} onValueChange={(v) => setEditStatus(v as TenantStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">有効</SelectItem>
                  <SelectItem value="suspended">停止中</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editError && (
              <div className="text-sm text-destructive">{editError}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleEdit}
              disabled={editLoading || !editName.trim()}
            >
              {editLoading ? "更新中..." : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 削除確認ダイアログ */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>テナントを削除</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              「{deletingTenant?.name}」（ID: {deletingTenant?.id}）を削除しますか？
            </p>
            <p className="text-sm text-destructive font-medium">
              テナント内の全データ（ユーザー、コース、レッスン等）が完全に削除されます。この操作は取り消せません。
            </p>
          </div>
          {deleteError && (
            <div className="text-sm text-destructive">{deleteError}</div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteLoading}
            >
              {deleteLoading ? "削除中..." : "削除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
