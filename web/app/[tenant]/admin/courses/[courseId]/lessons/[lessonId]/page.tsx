"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useTenant } from "@/lib/tenant-context";

type Lesson = {
  id: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
};

type VideoInfo = {
  id: string;
  gcsPath: string;
  durationSec: number | null;
  requiredWatchRatio: number;
  speedLock: boolean;
  playbackUrl?: string;
};

type LessonDetail = {
  lesson: Lesson;
  video: VideoInfo | null;
};

export default function LessonDetailPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const lessonId = params.lessonId as string;
  const { tenantId } = useTenant();
  const { authFetch } = useAuthenticatedFetch();

  const [lessonDetail, setLessonDetail] = useState<LessonDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);

  // Delete state
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<LessonDetail>(
        `/api/v1/admin/courses/${courseId}/lessons/${lessonId}`
      );
      setLessonDetail(data);

      // Fetch playback URL if video exists
      if (data.video) {
        try {
          const playbackData = await authFetch<{ playbackUrl: string }>(
            `/api/v1/videos/${data.video.id}/playback-url`
          );
          setLessonDetail((prev) =>
            prev
              ? {
                  ...prev,
                  video: prev.video
                    ? { ...prev.video, playbackUrl: playbackData.playbackUrl }
                    : null,
                }
              : null
          );
        } catch {
          // playback URL fetch failure is non-fatal
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch, courseId, lessonId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setDurationSec(null);
    setUploadError(null);

    if (file) {
      // Extract duration via a temporary video element
      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => {
        setDurationSec(Math.floor(vid.duration));
        URL.revokeObjectURL(url);
      };
      vid.src = url;
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);

    try {
      // Step 1: Get signed upload URL
      const { uploadUrl, gcsPath } = await authFetch<{
        uploadUrl: string;
        gcsPath: string;
      }>("/api/v1/admin/videos/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: selectedFile.name,
          contentType: selectedFile.type,
        }),
      });

      // Step 2: Upload directly to GCS with progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`GCSアップロードに失敗しました (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error("ネットワークエラーが発生しました"));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", selectedFile.type);
        xhr.send(selectedFile);
      });

      // Step 3: Register video metadata
      await authFetch(`/api/v1/admin/lessons/${lessonId}/video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gcsPath,
          sourceType: "gcs",
          durationSec,
        }),
      });

      setSelectedFile(null);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
      fetchData();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "アップロードに失敗しました");
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteVideo = async () => {
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await authFetch(`/api/v1/admin/lessons/${lessonId}/video`, {
        method: "DELETE",
      });
      fetchData();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  const lesson = lessonDetail?.lesson;
  const video = lessonDetail?.video;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href={`/${tenantId}/admin/courses`} className="hover:text-foreground">
          講座管理
        </Link>
        <span>/</span>
        <Link
          href={`/${tenantId}/admin/courses/${courseId}/lessons`}
          className="hover:text-foreground"
        >
          レッスン管理
        </Link>
        <span>/</span>
        <span className="text-foreground">{lesson?.title ?? "読み込み中..."}</span>
      </div>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">レッスン詳細</h1>
        {lesson && (
          <p className="text-sm text-muted-foreground mt-1">
            順序: {lesson.order} &nbsp;|&nbsp; {lesson.title}
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : (
        <>
          {/* Video Section */}
          <section className="rounded-md border p-6 space-y-4">
            <h2 className="text-lg font-semibold">動画</h2>

            {video ? (
              /* Video registered */
              <div className="space-y-4">
                {video.playbackUrl && (
                  <video
                    ref={videoPreviewRef}
                    src={video.playbackUrl}
                    controls
                    className="w-full max-w-md rounded-md border"
                  />
                )}

                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-md">
                  <dt className="text-muted-foreground">GCSパス</dt>
                  <dd className="truncate font-mono text-xs">{video.gcsPath}</dd>

                  <dt className="text-muted-foreground">再生時間</dt>
                  <dd>
                    {video.durationSec != null
                      ? `${video.durationSec} 秒`
                      : "不明"}
                  </dd>

                  <dt className="text-muted-foreground">必須視聴割合</dt>
                  <dd>{(video.requiredWatchRatio * 100).toFixed(0)}%</dd>

                  <dt className="text-muted-foreground">速度ロック</dt>
                  <dd>{video.speedLock ? "有効" : "無効"}</dd>
                </dl>

                {deleteError && (
                  <div className="text-sm text-destructive">{deleteError}</div>
                )}

                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteVideo}
                  disabled={deleteLoading}
                >
                  {deleteLoading ? "削除中..." : "動画を削除"}
                </Button>
              </div>
            ) : (
              /* No video — show upload form */
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  動画がまだ登録されていません。ファイルを選択してアップロードしてください。
                </p>

                <div className="space-y-2">
                  <label className="text-sm font-medium">動画ファイル</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*"
                    onChange={handleFileChange}
                    disabled={uploading}
                    className="block text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 disabled:opacity-50"
                  />
                </div>

                {selectedFile && (
                  <p className="text-sm text-muted-foreground">
                    {selectedFile.name}{" "}
                    {durationSec != null && `(${durationSec} 秒)`}
                  </p>
                )}

                {uploading && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>アップロード中...</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {uploadError && (
                  <div className="text-sm text-destructive">{uploadError}</div>
                )}

                <Button
                  onClick={handleUpload}
                  disabled={!selectedFile || uploading}
                >
                  {uploading ? "アップロード中..." : "アップロード"}
                </Button>
              </div>
            )}
          </section>

          {/* Quiz Section — placeholder */}
          <section className="rounded-md border p-6 space-y-2">
            <h2 className="text-lg font-semibold">クイズ</h2>
            <p className="text-sm text-muted-foreground">
              Phase 3で実装予定
            </p>
          </section>
        </>
      )}
    </div>
  );
}
