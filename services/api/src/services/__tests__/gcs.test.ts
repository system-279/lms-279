/**
 * gcs.ts 署名 URL 生成の transient リトライ回帰テスト。
 *
 * 2026-06-19 本番障害 (再発): 動画再生 URL 生成の IAM Credentials API `signBlob`
 * が `Premature close` で失敗し `GET /videos/:id/playback-url` が 500 を返した。
 * Session 78 (#579) は PDF 署名のみ retry 化し、動画署名 (gcs.ts) が漏れていた。
 *
 * テスト観点 (rules/testing.md §5 外部API transient/permanent 分類):
 *  - 初回成功時はリトライしない
 *  - transient (`Premature close`) で bounded retry → 回復すれば成功
 *  - transient が maxAttempts (3) 連続したら最後のエラーを throw
 *  - permanent エラー (HTTP 403) は即 throw (リトライしない)
 *  - generateUploadUrl (write 署名) も同じ retry が効く (横展開の検証)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getSignedUrlMock } = vi.hoisted(() => ({
  getSignedUrlMock: vi.fn(),
}));

vi.mock("@google-cloud/storage", () => ({
  // new Storage() で使われるため class でモックする (アロー関数は constructor 不可)。
  Storage: class {
    bucket() {
      return {
        file: () => ({ getSignedUrl: getSignedUrlMock }),
      };
    }
  },
}));

import { generatePlaybackUrl, generateUploadUrl } from "../gcs.js";
import { logger } from "../../utils/logger.js";

const SIGNED_URL = "https://signed.example.com/video.mp4?sig=abc";

/** 本番障害で観測された SigningError (transient な TCP 早期切断) を再現する。 */
function prematureCloseError(): Error {
  const e = new Error(
    "Invalid response body while trying to fetch " +
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa:signBlob: Premature close",
  );
  e.name = "SigningError";
  return e;
}

/** リトライ対象外の permanent エラー (権限不足等)。 */
function permanentError(): Error & { code: number } {
  const e = new Error("Permission denied") as Error & { code: number };
  e.code = 403;
  return e;
}

describe("gcs 署名 URL の transient リトライ (本番障害 2026-06-19 再発防止)", () => {
  let loggerWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  describe("generatePlaybackUrl (受講者の動画視聴 / 障害の直接原因)", () => {
    it("初回成功時はリトライせず URL を返す", async () => {
      getSignedUrlMock.mockResolvedValue([SIGNED_URL]);

      const url = await generatePlaybackUrl("tenant/videos/v1.mp4");

      expect(url).toBe(SIGNED_URL);
      expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it("Premature close で 1 回失敗しても retry で回復し URL を返す", async () => {
      getSignedUrlMock
        .mockRejectedValueOnce(prematureCloseError())
        .mockResolvedValue([SIGNED_URL]);

      const url = await generatePlaybackUrl("tenant/videos/v1.mp4");

      expect(url).toBe(SIGNED_URL);
      expect(getSignedUrlMock).toHaveBeenCalledTimes(2);
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      // context が log payload に渡ること
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        "gcs_signing_transient_retry",
        expect.objectContaining({ context: "generatePlaybackUrl" }),
      );
    });

    it("Premature close が maxAttempts (3) 連続したら最後のエラーを throw する", async () => {
      getSignedUrlMock.mockRejectedValue(prematureCloseError());

      await expect(generatePlaybackUrl("tenant/videos/v1.mp4")).rejects.toThrow(
        /Premature close/,
      );
      expect(getSignedUrlMock).toHaveBeenCalledTimes(3);
    });

    it("permanent エラー (HTTP 403) はリトライせず即 throw する", async () => {
      getSignedUrlMock.mockRejectedValue(permanentError());

      await expect(generatePlaybackUrl("tenant/videos/v1.mp4")).rejects.toThrow(
        /Permission denied/,
      );
      expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe("generateUploadUrl (管理者のアップロード署名 / 同一 signBlob 経路)", () => {
    it("Premature close で 1 回失敗しても retry で回復し uploadUrl を返す", async () => {
      getSignedUrlMock
        .mockRejectedValueOnce(prematureCloseError())
        .mockResolvedValue([SIGNED_URL]);

      const result = await generateUploadUrl("lesson.mp4", "video/mp4", "tenant-a");

      expect(result.uploadUrl).toBe(SIGNED_URL);
      expect(result.gcsPath).toContain("tenant-a/videos/");
      expect(result.gcsPath).toContain("lesson.mp4");
      expect(getSignedUrlMock).toHaveBeenCalledTimes(2);
    });
  });
});
