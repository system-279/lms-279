/**
 * GET /attendance-report レスポンスの anomalies マップ検証（F2、ADR-027）
 *
 * lesson_sessions fixture から overlap_previous / negative_duration / stale_active の
 * 3 異常種別が正しく付与され、synthetic session が overlap 検知のスイープから
 * 除外されることを確認する。firestore-admin モックハーネスは
 * attendance-report-synthetic.test.ts を流用。
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import supertest from "supertest";
import express from "express";

const SESSIONS_FIXTURE = [
  // overlap_previous: B の entryAt が A の exitAt より前 → B のみ flag
  {
    id: "session-a",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-1",
      entryAt: "2026-06-09T01:00:00.000Z",
      exitAt: "2026-06-09T01:30:00.000Z",
      exitReason: "quiz_submitted",
      status: "completed",
      isSynthetic: false,
    },
  },
  {
    id: "session-b",
    data: {
      userId: "user-1",
      courseId: "course-2",
      lessonId: "lesson-2",
      entryAt: "2026-06-09T01:15:00.000Z",
      exitAt: "2026-06-09T02:00:00.000Z",
      exitReason: "quiz_submitted",
      status: "completed",
      isSynthetic: false,
    },
  },
  // negative_duration: exitAt < entryAt
  {
    id: "session-c",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-3",
      entryAt: "2026-06-09T03:00:00.000Z",
      exitAt: "2026-06-09T02:00:00.000Z",
      exitReason: "time_limit",
      status: "force_exited",
      isSynthetic: false,
    },
  },
  // stale_active: 十分に古い entryAt のまま active
  {
    id: "session-d",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-4",
      entryAt: "2000-01-01T00:00:00.000Z",
      exitAt: null,
      exitReason: null,
      status: "active",
      isSynthetic: false,
    },
  },
  // synthetic session はスイープから除外される → 後続の session-f を巻き込まない
  {
    id: "session-e-synthetic",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-5",
      entryAt: "2026-06-09T04:00:00.000Z",
      exitAt: "2026-06-09T05:00:00.000Z",
      exitReason: "quiz_submitted",
      status: "completed",
      isSynthetic: true,
    },
  },
  {
    id: "session-f",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-6",
      entryAt: "2026-06-09T04:30:00.000Z",
      exitAt: "2026-06-09T04:45:00.000Z",
      exitReason: "quiz_submitted",
      status: "completed",
      isSynthetic: false,
    },
  },
];

function makeSnapshot(docs: { id: string; data: Record<string, unknown> }[]) {
  return {
    docs: docs.map((d) => ({
      id: d.id,
      data: () => d.data,
    })),
  };
}

function makeQuery(snapshot: ReturnType<typeof makeSnapshot>) {
  const queryObj: Record<string, unknown> = {
    orderBy: vi.fn(() => queryObj),
    where: vi.fn(() => queryObj),
    get: vi.fn(() => Promise.resolve(snapshot)),
  };
  return queryObj;
}

vi.mock("firebase-admin/firestore", () => {
  return {
    getFirestore: vi.fn(() => ({
      collection: vi.fn((path: string) => {
        if (path === "tenants") {
          return {
            doc: vi.fn(() => ({
              get: vi.fn(() => Promise.resolve({ exists: true, data: () => ({ name: "Test Tenant" }) })),
            })),
          };
        }
        if (path.endsWith("/lesson_sessions")) {
          return makeQuery(makeSnapshot(SESSIONS_FIXTURE));
        }
        if (path.endsWith("/users")) {
          return makeQuery(makeSnapshot([
            { id: "user-1", data: { name: "受講者1", email: "u1@example.com" } },
          ]));
        }
        if (path.endsWith("/quiz_attempts")) {
          return makeQuery(makeSnapshot([]));
        }
        if (path.endsWith("/lessons")) {
          return makeQuery(makeSnapshot([
            { id: "lesson-1", data: { title: "レッスン1" } },
            { id: "lesson-2", data: { title: "レッスン2" } },
            { id: "lesson-3", data: { title: "レッスン3" } },
            { id: "lesson-4", data: { title: "レッスン4" } },
            { id: "lesson-5", data: { title: "レッスン5" } },
            { id: "lesson-6", data: { title: "レッスン6" } },
          ]));
        }
        if (path.endsWith("/courses")) {
          return makeQuery(makeSnapshot([
            { id: "course-1", data: { name: "コース1" } },
            { id: "course-2", data: { name: "コース2" } },
          ]));
        }
        return makeQuery(makeSnapshot([]));
      }),
    })),
  };
});

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({
    verifyIdToken: vi.fn(),
    getUserByEmail: vi.fn(() => Promise.reject(new Error("not found"))),
  })),
}));

vi.mock("../../middleware/super-admin.js", () => ({
  superAdminAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  getAllSuperAdmins: vi.fn(() => Promise.resolve([])),
  addSuperAdmin: vi.fn(),
  removeSuperAdmin: vi.fn(),
  isSuperAdmin: vi.fn(() => Promise.resolve(false)),
}));

describe("GET /attendance-report anomalies マップ (F2, ADR-027)", () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const { superAdminRouter } = await import("../../routes/super-admin.js");
    const app = express();
    app.use(express.json());
    app.use(superAdminRouter);
    request = supertest(app);
  }, 30_000);

  function findRecord(body: { records: { id: string; anomalies?: string[] }[] }, id: string) {
    const record = body.records.find((r) => r.id === id);
    if (!record) throw new Error(`record ${id} not found`);
    return record;
  }

  it("後発の重複セッションのみ overlap_previous を持つ", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(res.status).toBe(200);
    expect(findRecord(res.body, "session-a").anomalies).toBeUndefined();
    expect(findRecord(res.body, "session-b").anomalies).toEqual(["overlap_previous"]);
  });

  it("exitAt < entryAt のセッションは negative_duration を持つ", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(findRecord(res.body, "session-c").anomalies).toEqual(["negative_duration"]);
  });

  it("長時間放置された active セッションは stale_active を持つ", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(findRecord(res.body, "session-d").anomalies).toEqual(["stale_active"]);
  });

  it("synthetic session は overlap 検知から除外され、後続セッションも巻き込まれない", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(findRecord(res.body, "session-e-synthetic").anomalies).toBeUndefined();
    expect(findRecord(res.body, "session-f").anomalies).toBeUndefined();
  });

  it("正常なセッションには anomalies フィールドが付与されない", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(findRecord(res.body, "session-a").anomalies).toBeUndefined();
  });
});
