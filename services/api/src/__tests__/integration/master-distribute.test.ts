/**
 * マスターコンテンツ配信API 統合テスト
 * distributeCourseToTenant はモックで差し替え
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

const mockDistribute = vi.fn().mockResolvedValue({
  tenantId: "tenant-1",
  courseId: "course-1",
  masterCourseId: "master-1",
  status: "success",
  lessonsCount: 2,
  videosCount: 1,
  quizzesCount: 1,
});

vi.mock("../../services/course-distributor.js", () => ({
  distributeCourseToTenant: mockDistribute,
}));

const { createSuperAdminApp } = await import("../helpers/create-super-admin-app.js");

describe("Master Distribute API", () => {
  let request: ReturnType<typeof supertest>;

  beforeEach(() => {
    testDS = new InMemoryDataSource({ readOnly: false });
    request = supertest(createSuperAdminApp());
    mockDistribute.mockClear();
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

      // distributeCourseToTenant が正しい引数で呼ばれること
      expect(mockDistribute).toHaveBeenCalledTimes(1);
      expect(mockDistribute).toHaveBeenCalledWith(
        expect.anything(), // db (mocked getFirestore)
        "course-1",
        "tenant-1",
        "super@test.com", // distributedBy = req.superAdmin.email
        { force: false },
      );
    });

    it("複数コース×複数テナントの直積展開で呼ばれる", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ courseIds: ["c1", "c2"], tenantIds: ["t1", "t2"] });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBe(4);
      expect(mockDistribute).toHaveBeenCalledTimes(4);

      // 4つの組み合わせが全て呼ばれること
      const calls = mockDistribute.mock.calls.map(
        (call: unknown[]) => `${call[1]}-${call[2]}`,
      );
      expect(calls).toContain("c1-t1");
      expect(calls).toContain("c1-t2");
      expect(calls).toContain("c2-t1");
      expect(calls).toContain("c2-t2");
    });

    it("courseIdsが未指定の場合400を返す", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ tenantIds: ["tenant-1"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_course_ids");
      expect(mockDistribute).not.toHaveBeenCalled();
    });

    it("tenantIdsが未指定の場合400を返す", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ courseIds: ["course-1"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_tenant_ids");
      expect(mockDistribute).not.toHaveBeenCalled();
    });

    it("予約済みテナントID(_master)を含む場合400を返す", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ courseIds: ["course-1"], tenantIds: ["_master"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_tenant_ids");
      expect(res.body.message).toContain("_master");
      expect(mockDistribute).not.toHaveBeenCalled();
    });

    it("不正な形式のテナントIDを含む場合400を返す", async () => {
      const res = await request
        .post("/master/distribute")
        .send({ courseIds: ["course-1"], tenantIds: ["valid-tenant", "invalid tenant!"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_tenant_ids");
      expect(mockDistribute).not.toHaveBeenCalled();
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
