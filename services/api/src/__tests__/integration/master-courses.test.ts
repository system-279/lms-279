/**
 * マスターコースCRUD 統合テスト
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";

// テスト用DS（各テストでリセット）
let testDS: InMemoryDataSource;

// FirestoreDataSource のコンストラクタが呼ばれるたびに testDS を返す
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

// ヘルパーをモック適用後にインポート
const { createSuperAdminApp } = await import("../helpers/create-super-admin-app.js");

describe("Master Courses API", () => {
  let request: ReturnType<typeof supertest>;

  beforeEach(() => {
    testDS = new InMemoryDataSource({ readOnly: false });
    request = supertest(createSuperAdminApp());
  });

  describe("GET /master/courses", () => {
    it("マスターコース一覧を取得して200を返す", async () => {
      // InMemoryDataSource の初期データ（3件）が含まれる
      const res = await request.get("/master/courses");

      expect(res.status).toBe(200);
      expect(res.body.courses).toBeDefined();
      expect(Array.isArray(res.body.courses)).toBe(true);
      expect(res.body.courses.length).toBeGreaterThanOrEqual(3);
    });

    it("status=draftでフィルタできる", async () => {
      await request.post("/master/courses").send({ name: "ドラフトコース" });

      const res = await request.get("/master/courses?status=draft");

      expect(res.status).toBe(200);
      expect(res.body.courses.length).toBeGreaterThanOrEqual(1);
      res.body.courses.forEach((c: { status: string }) => {
        expect(c.status).toBe("draft");
      });
    });

    it("無効なstatusで400を返す", async () => {
      const res = await request.get("/master/courses?status=xxx");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_status");
    });
  });

  describe("POST /master/courses", () => {
    it("マスターコースを作成して201を返す", async () => {
      const res = await request
        .post("/master/courses")
        .send({ name: "テストマスターコース", description: "テスト用" });

      expect(res.status).toBe(201);
      expect(res.body.course).toBeDefined();
      expect(res.body.course.name).toBe("テストマスターコース");
      expect(res.body.course.status).toBe("draft");
      expect(res.body.course.id).toBeDefined();
    });

    it("nameが空の場合400を返す", async () => {
      const res = await request.post("/master/courses").send({ name: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_name");
    });
  });

  describe("GET /master/courses/:id", () => {
    it("コース詳細とレッスン一覧を取得して200を返す", async () => {
      const created = await request
        .post("/master/courses")
        .send({ name: "詳細テスト" });
      const courseId = created.body.course.id;

      await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "レッスン1" });

      const res = await request.get(`/master/courses/${courseId}`);

      expect(res.status).toBe(200);
      expect(res.body.course.id).toBe(courseId);
      expect(res.body.lessons).toBeDefined();
      expect(res.body.lessons.length).toBe(1);
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request.get("/master/courses/xxx");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("PATCH /master/courses/:id", () => {
    it("マスターコースを更新して200を返す", async () => {
      const created = await request
        .post("/master/courses")
        .send({ name: "更新前" });
      const courseId = created.body.course.id;

      const res = await request
        .patch(`/master/courses/${courseId}`)
        .send({ name: "更新後", description: "説明追加" });

      expect(res.status).toBe(200);
      expect(res.body.course.name).toBe("更新後");
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request
        .patch("/master/courses/xxx")
        .send({ name: "更新" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("DELETE /master/courses/:id", () => {
    it("マスターコースと関連データを削除する", async () => {
      // コース → レッスン → 動画・テストを作成
      const created = await request
        .post("/master/courses")
        .send({ name: "削除テスト" });
      const courseId = created.body.course.id;

      const lessonRes = await request
        .post(`/master/courses/${courseId}/lessons`)
        .send({ title: "削除レッスン" });
      const lessonId = lessonRes.body.lesson.id;

      await request
        .post(`/master/lessons/${lessonId}/video`)
        .send({ durationSec: 60 });
      await request
        .post(`/master/lessons/${lessonId}/quiz`)
        .send({
          title: "削除テスト",
          questions: [{ id: "q1", text: "Q", type: "single", options: [{ id: "a", text: "A", isCorrect: true }], points: 10 }],
        });

      const res = await request.delete(`/master/courses/${courseId}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("削除");

      // コースが削除されていること
      const getRes = await request.get(`/master/courses/${courseId}`);
      expect(getRes.status).toBe(404);
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request.delete("/master/courses/xxx");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });
});
