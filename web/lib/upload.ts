/**
 * 署名 PUT URL に対して XHR でファイルアップロードし、進捗を callback に通知する。
 *
 * fetch API は upload progress を取れないため XMLHttpRequest を使う。
 * AbortSignal でキャンセル可能 (再試行 / コンポーネント unmount 時)。
 *
 * 3 段アップロードフローの「2 段目」 (GCS 直接 PUT) を担う共有 utility。
 * 動画 / PDF / 将来のリソースで共通利用する。
 */
export interface UploadProgressEvent {
  /** 0-100 の整数 */
  percent: number;
  /** 既送信バイト数 */
  loaded: number;
  /** 総バイト数 (lengthComputable === false なら 0) */
  total: number;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly kind: "http" | "network" | "aborted",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * @param file - アップロード対象ファイル
 * @param uploadUrl - 署名 PUT URL
 * @param onProgress - 進捗 callback (省略可)
 * @param signal - AbortSignal (省略可、abort で UploadError(kind: "aborted") を reject)
 */
export function uploadFileWithProgress(
  file: File,
  uploadUrl: string,
  onProgress?: (event: UploadProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError("aborted", "aborted"));
      return;
    }
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (!onProgress) return;
      onProgress({
        percent: event.lengthComputable
          ? Math.round((event.loaded / event.total) * 100)
          : 0,
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : 0,
      });
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new UploadError(
            `upload failed: HTTP ${xhr.status}`,
            "http",
            xhr.status,
          ),
        );
      }
    });

    xhr.addEventListener("error", () => {
      reject(new UploadError("network error during upload", "network"));
    });

    xhr.addEventListener("abort", () => {
      reject(new UploadError("aborted", "aborted"));
    });

    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort);
    xhr.addEventListener("loadend", () => {
      signal?.removeEventListener("abort", onAbort);
    });

    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.send(file);
  });
}
