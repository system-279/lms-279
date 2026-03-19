/**
 * マスターコンテンツ配信API 統合テスト
 * distributeCourseToTenant はモックで差し替え
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import supertest from "supertest";
import express from "express";
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
  distributeCourseToTenant: vi.fn().mockResolvedValue({
    tenantId: "tenant-1",
    courseId: "course-1",
    masterCourseId: "master-1",
    status: "success",
    lessonsCount: 2,
    videosCount: 1,
    quizzesCount: 1,
  }),
}));

const { masterRouter } = await import("../../routes/super-admin-master.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.superAdmin = { email: "super@test.com" };
    next();
  });
  app.use(masterRouter);
  return app;
}

describe("Master Distribute API", () => {
  let request: ReturnType<typeof supertest>;

  beforeEach(() => {
    testDS = new InMemoryDataSource({ readOnly: false });
    request = supertest(createApp());
  });

  describe("POST /master/distribute", () => {
    it("配信リクエストが成功して200を返す", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ courseIds: ["course-1"], tenantIds: ["tenant-1"] });

      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
      expect(Array.isArray(res.body.results)).toBe(true);
      expect(res.body.results.length).toBe(1);
      expect(res.body.results[0].status).toBe("success");
    });

    it("courseIdsが未指定の場合400を返す", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ tenantIds: ["tenant-1"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_course_ids");
    });

    it("tenantIdsが未指定の場合400を返す", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ courseIds: ["course-1"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_tenant_ids");
    });
  });

  describe("GET /master/courses/:id/distributions", () => {
    it("存在しないコースIDで404を返す", async () => {
      const res = await request.get("/master/courses/xxx/distributions");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });
});
