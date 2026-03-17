/**
 * コースルーター統合テスト
 * supertestを使ったHTTPレベルのテスト
 */

import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import { createTestApp, createStudentTestApp } from "../helpers/create-app.js";

describe("Courses API (admin)", () => {
  let request: ReturnType<typeof supertest>;

  beforeEach(() => {
    const { app } = createTestApp();
    request = supertest(app);
  });

  describe("POST /admin/courses", () => {
    it("コースを作成して201を返す", async () => {
      const res = await request
        .post("/admin/courses")
        .send({ name: "テストコース", description: "テスト用の講座です" });

      expect(res.status).toBe(201);
      expect(res.body.course).toBeDefined();
      expect(res.body.course.name).toBe("テストコース");
      expect(res.body.course.description).toBe("テスト用の講座です");
      expect(res.body.course.status).toBe("draft");
      expect(res.body.course.id).toBeDefined();
    });

    it("passThresholdを指定して作成できる", async () => {
      const res = await request
        .post("/admin/courses")
        .send({ name: "閾値コース", description: "合格率テスト", passThreshold: 90 });

      expect(res.status).toBe(201);
      expect(res.body.course.passThreshold).toBe(90);
    });

    it("nameが空の場合400を返す", async () => {
      const res = await request
        .post("/admin/courses")
        .send({ name: "", description: "説明" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_name");
    });

    it("descriptionが未指定の場合400を返す", async () => {
      const res = await request
        .post("/admin/courses")
        .send({ name: "テストコース" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_description");
    });
  });

  describe("GET /admin/courses", () => {
    it("コース一覧を返す（初期データを含む）", async () => {
      const res = await request.get("/admin/courses");

      expect(res.status).toBe(200);
      expect(res.body.courses).toBeDefined();
      expect(Array.isArray(res.body.courses)).toBe(true);
      // InMemoryDataSourceの初期データ（3件）が含まれる
      expect(res.body.courses.length).toBeGreaterThanOrEqual(3);
    });

    it("statusフィルタで絞り込める", async () => {
      const res = await request.get("/admin/courses?status=published");

      expect(res.status).toBe(200);
      expect(res.body.courses).toBeDefined();
      res.body.courses.forEach((course: { status: string }) => {
        expect(course.status).toBe("published");
      });
    });

    it("status=draftでドラフトのみ返す", async () => {
      const res = await request.get("/admin/courses?status=draft");

      expect(res.status).toBe(200);
      res.body.courses.forEach((course: { status: string }) => {
        expect(course.status).toBe("draft");
      });
    });

    it("無効なstatusの場合400を返す", async () => {
      const res = await request.get("/admin/courses?status=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_status");
    });
  });

  describe("GET /admin/courses/:id", () => {
    it("コース詳細を返す", async () => {
      // まずコース作成
      const created = await request
        .post("/admin/courses")
        .send({ name: "詳細テストコース", description: "詳細取得テスト" });
      const courseId = created.body.course.id;

      const res = await request.get(`/admin/courses/${courseId}`);

      expect(res.status).toBe(200);
      expect(res.body.course.id).toBe(courseId);
      expect(res.body.course.name).toBe("詳細テストコース");
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request.get("/admin/courses/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("PATCH /admin/courses/:id", () => {
    it("コースを更新できる", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "更新前コース", description: "更新前" });
      const courseId = created.body.course.id;

      const res = await request
        .patch(`/admin/courses/${courseId}`)
        .send({ name: "更新後コース", description: "更新後" });

      expect(res.status).toBe(200);
      expect(res.body.course.name).toBe("更新後コース");
      expect(res.body.course.description).toBe("更新後");
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request
        .patch("/admin/courses/nonexistent")
        .send({ name: "更新" });

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /admin/courses/:id/publish", () => {
    it("draft → published に遷移する", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "公開コース", description: "公開テスト" });
      const courseId = created.body.course.id;

      const res = await request.patch(`/admin/courses/${courseId}/publish`);

      expect(res.status).toBe(200);
      expect(res.body.course.status).toBe("published");
    });

    it("すでにpublishedの場合409を返す", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "二重公開コース", description: "二重公開テスト" });
      const courseId = created.body.course.id;

      await request.patch(`/admin/courses/${courseId}/publish`);
      const res = await request.patch(`/admin/courses/${courseId}/publish`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("already_published");
    });

    it("archivedコースはpublishできない（409）", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "アーカイブ公開テスト", description: "テスト" });
      const courseId = created.body.course.id;

      // publish → archive
      await request.patch(`/admin/courses/${courseId}/publish`);
      await request.patch(`/admin/courses/${courseId}/archive`);

      const res = await request.patch(`/admin/courses/${courseId}/publish`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("cannot_publish_archived");
    });
  });

  describe("PATCH /admin/courses/:id/archive", () => {
    it("published → archived に遷移する", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "アーカイブコース", description: "アーカイブテスト" });
      const courseId = created.body.course.id;

      await request.patch(`/admin/courses/${courseId}/publish`);
      const res = await request.patch(`/admin/courses/${courseId}/archive`);

      expect(res.status).toBe(200);
      expect(res.body.course.status).toBe("archived");
    });

    it("draft → archived にも遷移できる", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "ドラフトアーカイブ", description: "テスト" });
      const courseId = created.body.course.id;

      const res = await request.patch(`/admin/courses/${courseId}/archive`);

      expect(res.status).toBe(200);
      expect(res.body.course.status).toBe("archived");
    });

    it("すでにarchivedの場合409を返す", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "二重アーカイブ", description: "テスト" });
      const courseId = created.body.course.id;

      await request.patch(`/admin/courses/${courseId}/archive`);
      const res = await request.patch(`/admin/courses/${courseId}/archive`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("already_archived");
    });
  });

  describe("DELETE /admin/courses/:id", () => {
    it("draftコースを削除して204を返す", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "削除コース", description: "削除テスト" });
      const courseId = created.body.course.id;

      const res = await request.delete(`/admin/courses/${courseId}`);

      expect(res.status).toBe(204);

      // 削除後は404
      const getRes = await request.get(`/admin/courses/${courseId}`);
      expect(getRes.status).toBe(404);
    });

    it("publishedコースは削除できない（409）", async () => {
      const created = await request
        .post("/admin/courses")
        .send({ name: "公開済み削除テスト", description: "テスト" });
      const courseId = created.body.course.id;

      await request.patch(`/admin/courses/${courseId}/publish`);
      const res = await request.delete(`/admin/courses/${courseId}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("cannot_delete_published");
    });

    it("存在しないIDで404を返す", async () => {
      const res = await request.delete("/admin/courses/nonexistent");

      expect(res.status).toBe(404);
    });
  });
});

describe("Courses API (student)", () => {
  it("GET /courses → publishedのみ返す", async () => {
    // adminアプリでdraftとpublishedのコースを作成してから、studentで確認
    const { app: adminApp } = createTestApp();
    const adminRequest = supertest(adminApp);

    // publishedコースを作成
    const publishedRes = await adminRequest
      .post("/admin/courses")
      .send({ name: "公開コース（受講者テスト）", description: "テスト" });
    await adminRequest.patch(`/admin/courses/${publishedRes.body.course.id}/publish`);

    // draftコースも作成（受講者には見えないはず）
    await adminRequest
      .post("/admin/courses")
      .send({ name: "下書きコース（受講者テスト）", description: "テスト" });

    // 受講者アプリで確認（別インスタンスなのでshared dsではないが、
    // InMemoryDSの初期データ（published 2件）が含まれることを確認）
    const { app: studentApp } = createStudentTestApp();
    const studentRequest = supertest(studentApp);

    const res = await studentRequest.get("/courses");

    expect(res.status).toBe(200);
    expect(res.body.courses).toBeDefined();
    // 全てpublished
    res.body.courses.forEach((course: { status: string }) => {
      expect(course.status).toBe("published");
    });
    // progressが付与されている
    res.body.courses.forEach((course: { progress: unknown }) => {
      expect(course.progress).toBeDefined();
    });
  });

  it("adminエンドポイントへのアクセスは403（権限なし）", async () => {
    const { app } = createStudentTestApp();
    const request = supertest(app);

    const res = await request.get("/admin/courses");

    expect(res.status).toBe(403);
  });
});
