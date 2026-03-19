/**
 * マスターレッスンCRUD 統合テスト
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

describe("Master Lessons API", () => {
  let request: ReturnType<typeof supertest>;
  let courseId: string;

  beforeEach(async () => {
    testDS = new InMemoryDataSource({ readOnly: false });
    request = supertest(createSuperAdminApp());

    // テスト用コースを作成
    const created = await request
      .post("/master/courses")
      .send({ name: "レッスンテスト用コース" });
    courseId = created.body.course.id;
  });

  describe("GET /master/courses/:courseId/lessons", () => {
    it("レッスン一覧を取得して200を返す", async () => {
      await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "レッスンA" });

      const res = await request.get(`/master/courses/${courseId}/lessons`);

      expect(res.status).toBe(200);
      expect(res.body.lessons).toBeDefined();
      expect(res.body.lessons.length).toBe(1);
      expect(res.body.lessons[0].title).toBe("レッスンA");
    });
  });

  describe("POST /master/courses/:courseId/lessons", () => {
    it("レッスンを作成して201を返す", async () => {
      const res = await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "新規レッスン" });

      expect(res.status).toBe(201);
      expect(res.body.lesson).toBeDefined();
      expect(res.body.lesson.title).toBe("新規レッスン");
      expect(res.body.lesson.courseId).toBe(courseId);
      expect(res.body.lesson.order).toBe(0);
    });

    it("作成後にコースのlessonOrderに追加される", async () => {
      const lesson1 = await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "レッスン1" });
      const lesson2 = await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "レッスン2" });

      const courseRes = await request.get(`/master/courses/${courseId}`);
      expect(courseRes.body.course.lessonOrder).toContain(lesson1.body.lesson.id);
      expect(courseRes.body.course.lessonOrder).toContain(lesson2.body.lesson.id);
      expect(courseRes.body.course.lessonOrder.length).toBe(2);
    });

    it("titleが空の場合400を返す", async () => {
      const res = await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_title");
    });

    it("存在しないコースIDで404を返す", async () => {
      const res = await request
        .post("/master/courses/nonexistent/lessons")
        .send({ title: "レッスン" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("PATCH /master/lessons/:id", () => {
    it("レッスンを更新して200を返す", async () => {
      const created = await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "更新前レッスン" });
      const lessonId = created.body.lesson.id;

      const res = await request
        .patch(`/master/lessons/${lessonId}`)
        .send({ title: "更新後レッスン" });

      expect(res.status).toBe(200);
      expect(res.body.lesson.title).toBe("更新後レッスン");
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request
        .patch("/master/lessons/xxx")
        .send({ title: "更新" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("DELETE /master/lessons/:id", () => {
    it("レッスンを削除して204を返し、コースのlessonOrderからも除去される", async () => {
      const created = await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "削除テスト" });
      const lessonId = created.body.lesson.id;

      const res = await request.delete(`/master/lessons/${lessonId}`);
      expect(res.status).toBe(204);

      // コースのlessonOrderからも除去されていること
      const courseRes = await request.get(`/master/courses/${courseId}`);
      expect(courseRes.body.course.lessonOrder).not.toContain(lessonId);
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request.delete("/master/lessons/xxx");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });
});
