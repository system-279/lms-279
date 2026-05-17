"use client";

import { useEffect, useRef, useState } from "react";
import type {
  LessonResource,
  LessonPdfUploadUrlResponse,
  LessonPdfConfirmResponse,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { useSuperAdminFetch } from "@/lib/super-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  UploadError,
  uploadFileWithProgress,
  type UploadProgressEvent,
} from "@/lib/upload";

const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024;
const PDF_CONTENT_TYPE = "application/pdf";

interface MasterLessonPdfUploaderProps {
  lessonId: string;
  resource?: LessonResource;
  onUpdated: () => void | Promise<void>;
}

/**
 * BE のフラット形式エラー (ADR-010) を日本語メッセージに変換する。
 * 未知のコードは BE 提供 message にフォールバック。
 */
function formatPdfError(err: unknown): string {
  if (err instanceof UploadError) {
    if (err.kind === "aborted") return "アップロードを中止しました。";
    if (err.kind === "network") return "ネットワークエラーが発生しました。再度お試しください。";
    return `アップロードに失敗しました (HTTP ${err.status ?? "?"})。再度お試しください。`;
  }
  if (err instanceof ApiError) {
    switch (err.code) {
      case "invalid_file_type":
        return "PDF ファイルのみアップロード可能です。";
      case "file_too_large":
        return "ファイルサイズが上限 (50 MB) を超えています。";
      case "gcs_unavailable":
        return "一時的に取得できません。しばらくしてから再度お試しください。";
      case "lesson_not_found":
        return "レッスンが見つかりません。ページを再読み込みしてください。";
      case "gcs_file_missing":
        return "アップロードが完了していません。再度お試しください。";
      case "resource_not_found":
        return "対象 PDF が見つかりません。";
      case "network_error":
        return "ネットワークエラーが発生しました。再度お試しください。";
    }
    return err.message || "エラーが発生しました。再度お試しください。";
  }
  if (err instanceof Error) return err.message;
  return "エラーが発生しました。再度お試しください。";
}

export function MasterLessonPdfUploader({
  lessonId,
  resource,
  onUpdated,
}: MasterLessonPdfUploaderProps): React.ReactElement {
  const { superFetch } = useSuperAdminFetch();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // unmount 時に進行中のアップロードを abort し、setState の to-unmounted を防ぐ
  // (codex review 指摘: AbortSignal + cleanup の二重防御)
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setValidationError(null);
    setError(null);
    setSuccess(null);
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.type !== PDF_CONTENT_TYPE) {
      setValidationError("PDF ファイルのみアップロード可能です。");
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    if (file.size > MAX_PDF_SIZE_BYTES) {
      setValidationError("ファイルサイズが上限 (50 MB) を超えています。");
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setSelectedFile(file);
  };

  const resetSelection = () => {
    setSelectedFile(null);
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setProgress(0);
    setError(null);
    setSuccess(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const urlRes = await superFetch<LessonPdfUploadUrlResponse>(
        `/api/v2/super/master/lessons/${lessonId}/pdf-upload-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: selectedFile.name,
            contentType: selectedFile.type,
            sizeBytes: selectedFile.size,
          }),
          signal: controller.signal,
        },
      );

      await uploadFileWithProgress(
        selectedFile,
        urlRes.uploadUrl,
        (event: UploadProgressEvent) => setProgress(event.percent),
        controller.signal,
      );

      // GCS PUT 成功後 ~ confirm 前のキャンセル要求を明示的に検出
      // (codex review 指摘: ここでチェックしないと意図に反してメタ登録される)
      if (controller.signal.aborted) {
        throw new UploadError("aborted", "aborted");
      }

      await superFetch<LessonPdfConfirmResponse>(
        `/api/v2/super/master/lessons/${lessonId}/pdf`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gcsPath: urlRes.gcsPath,
            fileName: selectedFile.name,
            sizeBytes: selectedFile.size,
          }),
          signal: controller.signal,
        },
      );

      setSuccess(`「${selectedFile.name}」をアップロードしました。`);
      resetSelection();
      await onUpdated();
    } catch (e) {
      setError(formatPdfError(e));
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      await superFetch(`/api/v2/super/master/lessons/${lessonId}/pdf`, {
        method: "DELETE",
      });
      setSuccess("PDF を削除しました。");
      setDeleteOpen(false);
      await onUpdated();
    } catch (e) {
      setError(formatPdfError(e));
    } finally {
      setDeleting(false);
    }
  };

  const sizeMb = resource
    ? (resource.pdfSizeBytes / (1024 * 1024)).toFixed(1)
    : null;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">講座資料 (PDF)</p>
          {resource ? (
            <p className="text-xs text-muted-foreground">
              {resource.pdfFileName} ({sizeMb} MB)
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              受講者は当該レッスンのテスト合格後にダウンロードできます。
            </p>
          )}
        </div>
        {resource && !uploading && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDeleteOpen(true)}
            aria-label="PDF を削除"
          >
            削除
          </Button>
        )}
      </div>

      {!uploading && (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground" htmlFor={`pdf-input-${lessonId}`}>
            PDF ファイル (最大 50 MB) を選択して
            {resource ? "差し替え" : "アップロード"}
          </label>
          <input
            ref={inputRef}
            id={`pdf-input-${lessonId}`}
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
            className="block w-full text-sm"
          />
          {selectedFile && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                選択中: {selectedFile.name} (
                {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB)
              </span>
              <Button type="button" size="sm" onClick={handleUpload}>
                アップロード
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={resetSelection}
              >
                クリア
              </Button>
            </div>
          )}
        </div>
      )}

      {uploading && (
        <div className="space-y-2">
          <div
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="アップロード進捗"
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span
              className="text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              アップロード中... {progress}%
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleCancel}
            >
              中止
            </Button>
          </div>
        </div>
      )}

      {validationError && (
        <p className="text-xs text-destructive" role="alert">
          {validationError}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="text-xs text-emerald-600" role="status" aria-live="polite">
          {success}
        </p>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>PDF を削除しますか?</DialogTitle>
            <DialogDescription>
              マスター側 PDF メタを削除します。配信済みテナント側のメタは
              `sync-resources` 実行時に消えます (即時削除されません)。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              キャンセル
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "削除中..." : "削除する"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
