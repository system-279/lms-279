import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Storage } from "@google-cloud/storage";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import {
  LessonResourceError,
  MAX_PDF_SIZE_BYTES,
  PDF_MIME_TYPE,
  confirmPdfUpload,
  deletePdfResource,
  generatePdfDownloadUrl,
  generatePdfUploadUrl,
  toLessonResource,
} from "../lesson-resource.js";

// -----------------------------------------------
// vi.mock 用の Storage ファクトリ
// -----------------------------------------------
interface MockFile {
  getSignedUrl: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}
function buildMockStorage(overrides: Partial<MockFile> = {}): { storage: Storage; file: MockFile } {
  const file: MockFile = {
    getSignedUrl: vi.fn().mockResolvedValue(["https://signed.example.com/foo"]),
    exists: vi.fn().mockResolvedValue([true]),
    delete: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  const bucket = { file: vi.fn().mockReturnValue(file) };
  const storage = { bucket: vi.fn().mockReturnValue(bucket) } as unknown as Storage;
  return { storage, file };
}

const MASTER_LESSON_ID = "demo-lesson-1";
const COURSE_ID = "demo-course-1";
const USER_ID = "test-user-1";

describe("generatePdfUploadUrl", () => {
  let ds: InMemoryDataSource;
  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("正常系: PUT 用署名 URL と gcsPath を返す", async () => {
    const { storage, file } = buildMockStorage();
    const result = await generatePdfUploadUrl(
      ds,
      storage,
      MASTER_LESSON_ID,
      "資料.pdf",
      PDF_MIME_TYPE,
      1024,
    );
    expect(result.uploadUrl).toBe("https://signed.example.com/foo");
    expect(result.gcsPath).toMatch(/^lessons\/demo-lesson-1\/\d+_資料\.pdf$/);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(file.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: "write", contentType: PDF_MIME_TYPE }),
    );
  });

  it("invalid_file_type: contentType が PDF 以外 → エラー", async () => {
    const { storage } = buildMockStorage();
    await expect(
      generatePdfUploadUrl(ds, storage, MASTER_LESSON_ID, "x.pdf", "image/png", 1024),
    ).rejects.toThrow(LessonResourceError);
  });

  it("file_too_large: 50MB + 1 byte → エラー", async () => {
    const { storage } = buildMockStorage();
    await expect(
      generatePdfUploadUrl(
        ds,
        storage,
        MASTER_LESSON_ID,
        "x.pdf",
        PDF_MIME_TYPE,
        MAX_PDF_SIZE_BYTES + 1,
      ),
    ).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("file_too_large: 0 byte は不正値として弾く", async () => {
    const { storage } = buildMockStorage();
    await expect(
      generatePdfUploadUrl(ds, storage, MASTER_LESSON_ID, "x.pdf", PDF_MIME_TYPE, 0),
    ).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("lesson_not_found: lesson 不在 → エラー", async () => {
    const { storage } = buildMockStorage();
    await expect(
      generatePdfUploadUrl(ds, storage, "nonexistent", "x.pdf", PDF_MIME_TYPE, 1024),
    ).rejects.toMatchObject({ code: "lesson_not_found" });
  });

  it("path traversal 試行: basename のみ抽出される", async () => {
    const { storage } = buildMockStorage();
    const result = await generatePdfUploadUrl(
      ds,
      storage,
      MASTER_LESSON_ID,
      "../../etc/passwd.pdf",
      PDF_MIME_TYPE,
      1024,
    );
    expect(result.gcsPath).not.toContain("../");
    expect(result.gcsPath).toMatch(/passwd\.pdf$/);
  });

  it("invalid_file_type: 拡張子が .pdf でない名前 → エラー", async () => {
    const { storage } = buildMockStorage();
    await expect(
      generatePdfUploadUrl(ds, storage, MASTER_LESSON_ID, "x.exe", PDF_MIME_TYPE, 1024),
    ).rejects.toMatchObject({ code: "invalid_file_type" });
  });
});

describe("confirmPdfUpload", () => {
  let ds: InMemoryDataSource;
  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("invalid_file_type: gcsPath が lessons/{lessonId}/ プレフィックスでない → エラー", async () => {
    const { storage } = buildMockStorage();
    await expect(
      confirmPdfUpload(ds, storage, MASTER_LESSON_ID, "../other/x.pdf", "x.pdf", 100),
    ).rejects.toMatchObject({ code: "invalid_file_type" });
  });

  it("file_too_large: confirm 時の sizeBytes 再検証 → エラー", async () => {
    const { storage } = buildMockStorage();
    await expect(
      confirmPdfUpload(
        ds,
        storage,
        MASTER_LESSON_ID,
        `lessons/${MASTER_LESSON_ID}/x.pdf`,
        "x.pdf",
        MAX_PDF_SIZE_BYTES + 1,
      ),
    ).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("AC-9 メタ削除失敗 → throw が伝播する (状態復旧優先)", async () => {
    // updateLesson に失敗を注入
    const failingDs = new InMemoryDataSource({ readOnly: false });
    const { storage } = buildMockStorage();
    // 一度 PDF を付ける
    await confirmPdfUpload(failingDs, storage, MASTER_LESSON_ID, `lessons/${MASTER_LESSON_ID}/old.pdf`, "old.pdf", 100);
    // 次の updateLesson を失敗させる
    vi.spyOn(failingDs, "updateLesson").mockRejectedValueOnce(new Error("firestore down"));
    await expect(deletePdfResource(failingDs, storage, MASTER_LESSON_ID)).rejects.toThrow("firestore down");
  });

  it("正常系: メタ書込み + 他フィールド未破壊", async () => {
    const before = await ds.getLessonById(MASTER_LESSON_ID);
    const { storage } = buildMockStorage();
    const result = await confirmPdfUpload(
      ds,
      storage,
      MASTER_LESSON_ID,
      `lessons/${MASTER_LESSON_ID}/123_x.pdf`,
      "x.pdf",
      2048,
    );
    expect(result.pdfFileName).toBe("x.pdf");
    expect(result.pdfSizeBytes).toBe(2048);
    expect(new Date(result.pdfUpdatedAt).getTime()).toBeGreaterThan(0);

    const after = await ds.getLessonById(MASTER_LESSON_ID);
    expect(after?.pdfGcsPath).toBe(`lessons/${MASTER_LESSON_ID}/123_x.pdf`);
    // Partial Update 検証: 他フィールド未破壊
    expect(after?.title).toBe(before?.title);
    expect(after?.order).toBe(before?.order);
    expect(after?.hasVideo).toBe(before?.hasVideo);
    expect(after?.hasQuiz).toBe(before?.hasQuiz);
    expect(after?.videoUnlocksPrior).toBe(before?.videoUnlocksPrior);
  });

  it("gcs_file_missing: GCS にファイル不在 → エラー", async () => {
    const { storage } = buildMockStorage({ exists: vi.fn().mockResolvedValue([false]) });
    await expect(
      confirmPdfUpload(ds, storage, MASTER_LESSON_ID, `lessons/${MASTER_LESSON_ID}/y.pdf`, "y.pdf", 100),
    ).rejects.toMatchObject({ code: "gcs_file_missing" });
  });

  it("既存 PDF があれば旧 GCS ファイルを削除する", async () => {
    // 1 回目アップロード
    const { storage: s1 } = buildMockStorage();
    await confirmPdfUpload(ds, s1, MASTER_LESSON_ID, `lessons/${MASTER_LESSON_ID}/old.pdf`, "old.pdf", 100);

    // 2 回目アップロード
    const { storage: s2, file: f2 } = buildMockStorage();
    await confirmPdfUpload(ds, s2, MASTER_LESSON_ID, `lessons/${MASTER_LESSON_ID}/new.pdf`, "new.pdf", 200);

    expect(f2.delete).toHaveBeenCalled(); // 旧ファイル削除
  });
});

describe("deletePdfResource", () => {
  let ds: InMemoryDataSource;
  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });
    const { storage } = buildMockStorage();
    await confirmPdfUpload(ds, storage, MASTER_LESSON_ID, `lessons/${MASTER_LESSON_ID}/y.pdf`, "y.pdf", 100);
  });

  it("正常系: メタクリア + GCS 削除", async () => {
    const { storage, file } = buildMockStorage();
    await deletePdfResource(ds, storage, MASTER_LESSON_ID);
    const lesson = await ds.getLessonById(MASTER_LESSON_ID);
    expect(lesson?.pdfGcsPath).toBeFalsy();
    expect(file.delete).toHaveBeenCalled();
  });

  it("GCS 削除失敗は orphan ログのみで成功扱い (throw しない)", async () => {
    const { storage } = buildMockStorage({
      delete: vi.fn().mockRejectedValue(new Error("gcs down")),
    });
    await expect(deletePdfResource(ds, storage, MASTER_LESSON_ID)).resolves.toBeUndefined();
    // メタは削除済み
    const lesson = await ds.getLessonById(MASTER_LESSON_ID);
    expect(lesson?.pdfGcsPath).toBeFalsy();
  });

  it("resource_not_found: PDF 未添付レッスンに対する削除 → エラー", async () => {
    const ds2 = new InMemoryDataSource({ readOnly: false });
    const { storage } = buildMockStorage();
    await expect(
      deletePdfResource(ds2, storage, MASTER_LESSON_ID),
    ).rejects.toMatchObject({ code: "resource_not_found" });
  });
});

describe("generatePdfDownloadUrl", () => {
  let ds: InMemoryDataSource;
  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });
    // テナント受講期間設定: 受講中 (videoAccessUntil = +1 年)
    await ds.upsertTenantEnrollmentSetting({
      enrolledAt: new Date().toISOString(),
      quizAccessUntil: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
      videoAccessUntil: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      createdBy: "admin@example.com",
    });
    // テスト合格状態
    await ds.upsertUserProgress(USER_ID, MASTER_LESSON_ID, {
      courseId: COURSE_ID,
      videoCompleted: true,
      quizPassed: true,
    });
    // PDF 添付
    const { storage } = buildMockStorage();
    await confirmPdfUpload(ds, storage, MASTER_LESSON_ID, `lessons/${MASTER_LESSON_ID}/y.pdf`, "資料.pdf", 100);
  });

  it("access_expired: TenantEnrollmentSetting 未設定 → エラー (default close)", async () => {
    const ds2 = new InMemoryDataSource({ readOnly: false });
    const { storage: s2 } = buildMockStorage();
    await confirmPdfUpload(ds2, s2, MASTER_LESSON_ID, `lessons/${MASTER_LESSON_ID}/y.pdf`, "資料.pdf", 100);
    await ds2.upsertUserProgress(USER_ID, MASTER_LESSON_ID, {
      courseId: COURSE_ID,
      quizPassed: true,
    });
    // enrollment setting なし
    await expect(
      generatePdfDownloadUrl(ds2, s2, MASTER_LESSON_ID, USER_ID),
    ).rejects.toMatchObject({ code: "access_expired" });
  });

  it("正常系: 15 分有効の署名 URL を返す", async () => {
    const { storage } = buildMockStorage();
    const result = await generatePdfDownloadUrl(ds, storage, MASTER_LESSON_ID, USER_ID);
    expect(result.url).toBe("https://signed.example.com/foo");
    expect(result.fileName).toBe("資料.pdf");
    const expiresInMs = new Date(result.expiresAt).getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan(14 * 60 * 1000);
    expect(expiresInMs).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("quiz_not_passed: quizPassed=false → エラー", async () => {
    await ds.upsertUserProgress(USER_ID, MASTER_LESSON_ID, {
      courseId: COURSE_ID,
      quizPassed: false,
    });
    const { storage } = buildMockStorage();
    await expect(
      generatePdfDownloadUrl(ds, storage, MASTER_LESSON_ID, USER_ID),
    ).rejects.toMatchObject({ code: "quiz_not_passed" });
  });

  it("access_expired: videoAccessUntil <= now → エラー", async () => {
    await ds.upsertTenantEnrollmentSetting({
      enrolledAt: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString(),
      quizAccessUntil: new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(),
      videoAccessUntil: new Date(Date.now() - 1000).toISOString(),
      createdBy: "admin@example.com",
    });
    const { storage } = buildMockStorage();
    await expect(
      generatePdfDownloadUrl(ds, storage, MASTER_LESSON_ID, USER_ID),
    ).rejects.toMatchObject({ code: "access_expired" });
  });

  it("lesson_not_found: lesson 不在 → エラー", async () => {
    const { storage } = buildMockStorage();
    await expect(
      generatePdfDownloadUrl(ds, storage, "nonexistent", USER_ID),
    ).rejects.toMatchObject({ code: "lesson_not_found" });
  });

  it("resource_not_found: PDF 未添付 → エラー", async () => {
    // 別レッスン (PDF 未添付) で確認
    await ds.upsertUserProgress(USER_ID, "demo-lesson-2", {
      courseId: COURSE_ID,
      videoCompleted: true,
      quizPassed: true,
    });
    const { storage } = buildMockStorage();
    await expect(
      generatePdfDownloadUrl(ds, storage, "demo-lesson-2", USER_ID),
    ).rejects.toMatchObject({ code: "resource_not_found" });
  });
});

describe("toLessonResource", () => {
  it("全フィールド揃いで LessonResource を返す", () => {
    const result = toLessonResource({
      pdfGcsPath: "x/y.pdf",
      pdfFileName: "y.pdf",
      pdfSizeBytes: 100,
      pdfUpdatedAt: "2026-05-17T00:00:00.000Z",
    });
    expect(result).toEqual({
      pdfFileName: "y.pdf",
      pdfSizeBytes: 100,
      pdfUpdatedAt: "2026-05-17T00:00:00.000Z",
    });
  });

  it("pdfGcsPath が undefined なら undefined を返す", () => {
    expect(toLessonResource({})).toBeUndefined();
  });

  it("pdfGcsPath が空文字 (削除済み) なら undefined を返す", () => {
    expect(
      toLessonResource({
        pdfGcsPath: "",
        pdfFileName: "",
        pdfSizeBytes: 0,
        pdfUpdatedAt: "2026-05-17T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});
