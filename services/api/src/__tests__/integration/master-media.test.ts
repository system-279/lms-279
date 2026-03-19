/**
 * マスター動画・クイズCRUD 統合テスト
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";

let testDS: InMemoryDataSource;

vi.mock("../../datasource/firestore.js", () => ({
  FirestoreDataSource: vi.fn(function () {
    return testDS;
  }),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  Firestore: vi.fn(),
  FieldValue: { serverTimestamp: vi.fn() },
}));

vi.mock("../../services/course-distributor.js", () => ({
  distributeCourseToTenant: vi.fn(),
}));

const { createSuperAdminApp } = await import("../helpers/create-super-admin-app.js");

describe("Master Media API", () => {
  let request: ReturnType<typeof supertest>;
  let courseId: string;
  let lessonId: string;

  beforeEach(async () => {
    testDS = new InMemoryDataSource({ readOnly: false });
    request = supertest(createSuperAdminApp());

    const course = await request
      .post("/master/courses")
      .send({ name: "メディアテスト用コース" });
    courseId = course.body.course.id;

    const lesson = await request
      .post(`/master/courses/${courseId}/lessons`)
      .send({ title: "メディアテスト用レッスン" });
    lessonId = lesson.body.lesson.id;
  });

  // ============================================================
  // 動画CRUD
  // ============================================================

  describe("POST /master/lessons/:lessonId/video", () => {
    it("動画を作成して201を返す", async () => {
      const res = await request
        .post(`/master/lessons/${lessonId}/video`)
        .send({ sourceType: "external_url", sourceUrl: "https://example.com/video.mp4", durationSec: 120 });

      expect(res.status).toBe(201);
      expect(res.body.video).toBeDefined();
      expect(res.body.video.lessonId).toBe(lessonId);
      expect(res.body.video.courseId).toBe(courseId);
      expect(res.body.video.durationSec).toBe(120);
    });

    it("動画作成後にレッスンのhasVideoがtrueになる", async () => {
      await request
        .post(`/master/lessons/${lessonId}/video`)
        .send({ durationSec: 60 });

      // レッスン詳細を取得して確認
      const courseRes = await request.get(`/master/courses/${courseId}`);
      const lesson = courseRes.body.lessons.find((l: { id: string }) => l.id === lessonId);
      expect(lesson.hasVideo).toBe(true);
    });

    it("存在しないレッスンIDで404を返す", async () => {
      const res = await request
        .post("/master/lessons/xxx/video")
        .send({ sourceType: "gcs" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("PATCH /master/videos/:id", () => {
    it("動画を更新して200を返す", async () => {
      const created = await request
        .post(`/master/lessons/${lessonId}/video`)
        .send({ durationSec: 60 });
      const videoId = created.body.video.id;

      const res = await request
        .patch(`/master/videos/${videoId}`)
        .send({ durationSec: 300 });

      expect(res.status).toBe(200);
      expect(res.body.video.durationSec).toBe(300);
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request
        .patch("/master/videos/xxx")
        .send({ durationSec: 100 });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("DELETE /master/videos/:id", () => {
    it("動画を削除して204を返し、レッスンのhasVideoがfalseになる", async () => {
      const created = await request
        .post(`/master/lessons/${lessonId}/video`)
        .send({});
      const videoId = created.body.video.id;

      const res = await request.delete(`/master/videos/${videoId}`);
      expect(res.status).toBe(204);

      // hasVideo が false に戻っていること
      const courseRes = await request.get(`/master/courses/${courseId}`);
      const lesson = courseRes.body.lessons.find((l: { id: string }) => l.id === lessonId);
      expect(lesson.hasVideo).toBe(false);
    });
  });

  describe("DELETE /master/lessons/:lessonId/video", () => {
    it("レッスンIDから動画を削除して204を返し、hasVideoがfalseになる", async () => {
      await request
        .post(`/master/lessons/${lessonId}/video`)
        .send({});

      const res = await request.delete(`/master/lessons/${lessonId}/video`);
      expect(res.status).toBe(204);

      const courseRes = await request.get(`/master/courses/${courseId}`);
      const lesson = courseRes.body.lessons.find((l: { id: string }) => l.id === lessonId);
      expect(lesson.hasVideo).toBe(false);
    });
  });

  // ============================================================
  // クイズCRUD
  // ============================================================

  const sampleQuestions = [
    {
      id: "q1",
      text: "テスト問題1",
      type: "single",
      options: [
        { id: "q1-a", text: "選択肢A", isCorrect: true },
        { id: "q1-b", text: "選択肢B", isCorrect: false },
      ],
      points: 10,
    },
  ];

  describe("POST /master/lessons/:lessonId/quiz", () => {
    it("クイズを作成して201を返す", async () => {
      const res = await request
        .post(`/master/lessons/${lessonId}/quiz`)
        .send({ title: "テストクイズ", questions: sampleQuestions });

      expect(res.status).toBe(201);
      expect(res.body.quiz).toBeDefined();
      expect(res.body.quiz.title).toBe("テストクイズ");
      expect(res.body.quiz.lessonId).toBe(lessonId);
      expect(res.body.quiz.questions).toHaveLength(1);
    });

    it("クイズ作成後にレッスンのhasQuizがtrueになる", async () => {
      await request
        .post(`/master/lessons/${lessonId}/quiz`)
        .send({ title: "テストクイズ", questions: sampleQuestions });

      const courseRes = await request.get(`/master/courses/${courseId}`);
      const lesson = courseRes.body.lessons.find((l: { id: string }) => l.id === lessonId);
      expect(lesson.hasQuiz).toBe(true);
    });

    it("questions付きで正しく作成できる", async () => {
      const multiQuestions = [
        ...sampleQuestions,
        {
          id: "q2",
          text: "テスト問題2",
          type: "multi",
          options: [
            { id: "q2-a", text: "A", isCorrect: true },
            { id: "q2-b", text: "B", isCorrect: true },
            { id: "q2-c", text: "C", isCorrect: false },
          ],
          points: 20,
        },
      ];

      const res = await request
        .post(`/master/lessons/${lessonId}/quiz`)
        .send({ title: "複数問題クイズ", questions: multiQuestions });

      expect(res.status).toBe(201);
      expect(res.body.quiz.questions).toHaveLength(2);
    });

    it("存在しないレッスンIDで404を返す", async () => {
      const res = await request
        .post("/master/lessons/xxx/quiz")
        .send({ title: "テスト", questions: sampleQuestions });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("PATCH /master/quizzes/:id", () => {
    it("クイズを更新して200を返す", async () => {
      const created = await request
        .post(`/master/lessons/${lessonId}/quiz`)
        .send({ title: "更新前クイズ", questions: sampleQuestions });
      const quizId = created.body.quiz.id;

      const res = await request
        .patch(`/master/quizzes/${quizId}`)
        .send({ title: "更新後クイズ", passThreshold: 80 });

      expect(res.status).toBe(200);
      expect(res.body.quiz.title).toBe("更新後クイズ");
      expect(res.body.quiz.passThreshold).toBe(80);
    });
  });

  describe("DELETE /master/quizzes/:id", () => {
    it("クイズを削除して204を返し、レッスンのhasQuizがfalseになる", async () => {
      const created = await request
        .post(`/master/lessons/${lessonId}/quiz`)
        .send({ title: "削除クイズ", questions: sampleQuestions });
      const quizId = created.body.quiz.id;

      const res = await request.delete(`/master/quizzes/${quizId}`);
      expect(res.status).toBe(204);

      // hasQuiz が false に戻っていること
      const courseRes = await request.get(`/master/courses/${courseId}`);
      const lesson = courseRes.body.lessons.find((l: { id: string }) => l.id === lessonId);
      expect(lesson.hasQuiz).toBe(false);
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request.delete("/master/quizzes/xxx");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("DELETE /master/lessons/:lessonId/quiz", () => {
    it("レッスンIDからクイズを削除して204を返し、hasQuizがfalseになる", async () => {
      await request
        .post(`/master/lessons/${lessonId}/quiz`)
        .send({ title: "削除クイズ2", questions: sampleQuestions });

      const res = await request.delete(`/master/lessons/${lessonId}/quiz`);
      expect(res.status).toBe(204);

      const courseRes = await request.get(`/master/courses/${courseId}`);
      const lesson = courseRes.body.lessons.find((l: { id: string }) => l.id === lessonId);
      expect(lesson.hasQuiz).toBe(false);
    });
  });
});
