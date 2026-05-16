/**
 * 講座資料 PDF ダウンロード機能の統合テスト
 * AC-4 (合格時), AC-5 (未合格), AC-6 (期間切れ), AC-7 (PDF 未添付), AC-8 (他テナント侵入)
 * を HTTP レイヤーで検証する。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { createStudentTestApp } from "../helpers/create-app.js";
import type { InMemoryDataSource } from "../../datasource/in-memory.js";

// GCS Storage を完全モック (new Storage() で呼ぶため class として定義)
vi.mock("@google-cloud/storage", () => {
  class MockStorage {
    bucket() {
      return {
        file: () => ({
          getSignedUrl: () => Promise.resolve(["https://signed.example.com/foo"]),
          exists: () => Promise.resolve([true]),
          delete: () => Promise.resolve([]),
        }),
      };
    }
  }
  return { Storage: MockStorage };
});

describe("Lesson PDF Download (integration)", () => {
  let request: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  const STUDENT_ID = "test-student-1";
  const LESSON_ID = "demo-lesson-1"; // InMemoryDataSource の初期データ
  const COURSE_ID = "demo-course-1";

  beforeEach(async () => {
    const app = createStudentTestApp();
    request = supertest(app.app);
    ds = app.ds;

    // PDF メタを直接注入 (super-admin の confirmPdfUpload 経由をスキップ)
    await ds.updateLesson(LESSON_ID, {
      pdfGcsPath: "lessons/demo-lesson-1/123_intro.pdf",
      pdfFileName: "intro.pdf",
      pdfSizeBytes: 12345,
      pdfUpdatedAt: "2026-05-17T00:00:00.000Z",
    });

    // 受講期間設定: 受講中
    await ds.upsertTenantEnrollmentSetting({
      enrolledAt: new Date().toISOString(),
      quizAccessUntil: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
      videoAccessUntil: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      createdBy: "admin@test.com",
    });

    // テスト合格状態
    await ds.upsertUserProgress(STUDENT_ID, LESSON_ID, {
      courseId: COURSE_ID,
      videoCompleted: true,
      quizPassed: true,
    });
  });

  it("AC-4 正常系: 合格 + 期間内 → 200 + url + fileName + expiresAt", async () => {
    const res = await request.get(`/lessons/${LESSON_ID}/pdf-download`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://signed.example.com/foo");
    expect(res.body.fileName).toBe("intro.pdf");
    expect(typeof res.body.expiresAt).toBe("string");
  });

  it("AC-5 未合格: quizPassed=false → 403 quiz_not_passed", async () => {
    await ds.upsertUserProgress(STUDENT_ID, LESSON_ID, {
      courseId: COURSE_ID,
      quizPassed: false,
    });
    const res = await request.get(`/lessons/${LESSON_ID}/pdf-download`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("quiz_not_passed");
  });

  it("AC-6 期間切れ: videoAccessUntil <= now → 403 access_expired", async () => {
    await ds.upsertTenantEnrollmentSetting({
      enrolledAt: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString(),
      quizAccessUntil: new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(),
      videoAccessUntil: new Date(Date.now() - 1000).toISOString(),
      createdBy: "admin@test.com",
    });
    const res = await request.get(`/lessons/${LESSON_ID}/pdf-download`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("access_expired");
  });

  it("AC-7 PDF 未添付: pdfGcsPath クリア後 → 404 resource_not_found", async () => {
    await ds.updateLesson(LESSON_ID, {
      pdfGcsPath: "",
      pdfFileName: "",
      pdfSizeBytes: 0,
    });
    const res = await request.get(`/lessons/${LESSON_ID}/pdf-download`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("resource_not_found");
  });

  it("AC-8 列挙攻撃: 存在しない lessonId → 404 lesson_not_found", async () => {
    const res = await request.get(`/lessons/nonexistent-lesson/pdf-download`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("lesson_not_found");
  });

  it("GET /lessons/:lessonId 受講者向け: resource? を含む (pdfGcsPath は除外)", async () => {
    const res = await request.get(`/lessons/${LESSON_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.lesson.id).toBe(LESSON_ID);
    // pdfGcsPath は受講者レスポンスに含めない
    expect(res.body.lesson.pdfGcsPath).toBeUndefined();
    // resource? に公開メタを含める
    expect(res.body.resource).toEqual({
      pdfFileName: "intro.pdf",
      pdfSizeBytes: 12345,
      pdfUpdatedAt: "2026-05-17T00:00:00.000Z",
    });
  });

  it("GET /lessons/:lessonId: PDF 未添付なら resource undefined", async () => {
    await ds.updateLesson(LESSON_ID, {
      pdfGcsPath: "",
      pdfFileName: "",
      pdfSizeBytes: 0,
    });
    const res = await request.get(`/lessons/${LESSON_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.resource).toBeUndefined();
  });
});
