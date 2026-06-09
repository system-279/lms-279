/**
 * GET /attendance-report レスポンスの isSynthetic マップ検証
 *
 * Issue #533 Phase 3 / #551:
 *  - lesson_sessions.isSynthetic === true → response.isSynthetic = true
 *  - lesson_sessions.isSynthetic 欠落 / false / null → response.isSynthetic = false
 *
 * 防御的: API layer で `=== true` 比較し boolean 正規化（Phase 1/2 投入前の既存 doc 対応）
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import supertest from "supertest";
import express from "express";

// lesson_sessions の固定 fixture（synthetic 1 件 + actual 1 件 + isSynthetic 欠落 1 件）
const SESSIONS_FIXTURE = [
  {
    id: "synth-session-1",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-1",
      entryAt: "2026-06-09T01:00:00.000Z",
      exitAt: "2026-06-09T01:30:00.000Z",
      exitReason: "quiz_submitted",
      status: "completed",
      quizAttemptId: "attempt-1",
      isSynthetic: true,
    },
  },
  {
    id: "actual-session-1",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-1",
      entryAt: "2026-06-09T02:00:00.000Z",
      exitAt: "2026-06-09T02:45:00.000Z",
      exitReason: "quiz_submitted",
      status: "completed",
      quizAttemptId: "attempt-2",
      isSynthetic: false,
    },
  },
  {
    id: "legacy-session-1",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-1",
      entryAt: "2026-06-09T03:00:00.000Z",
      exitAt: "2026-06-09T03:15:00.000Z",
      exitReason: "time_limit",
      status: "force_exited",
      // isSynthetic フィールド欠落（Phase 1/2 投入前の既存 doc 想定）
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
        // tenants/{tid} 取得
        if (path === "tenants") {
          return {
            doc: vi.fn(() => ({
              get: vi.fn(() => Promise.resolve({ exists: true, data: () => ({ name: "Test Tenant" }) })),
            })),
          };
        }
        // tenants/{tid}/lesson_sessions
        if (path.endsWith("/lesson_sessions")) {
          return makeQuery(makeSnapshot(SESSIONS_FIXTURE));
        }
        // users / quiz_attempts / lessons / courses
        if (path.endsWith("/users")) {
          return makeQuery(makeSnapshot([
            { id: "user-1", data: { name: "受講者1", email: "u1@example.com" } },
          ]));
        }
        if (path.endsWith("/quiz_attempts")) {
          return makeQuery(makeSnapshot([
            { id: "attempt-1", data: { score: 100, isPassed: true, submittedAt: "2026-06-09T01:30:00.000Z" } },
            { id: "attempt-2", data: { score: 80, isPassed: true, submittedAt: "2026-06-09T02:45:00.000Z" } },
          ]));
        }
        if (path.endsWith("/lessons")) {
          return makeQuery(makeSnapshot([
            { id: "lesson-1", data: { title: "テストレッスン" } },
          ]));
        }
        if (path.endsWith("/courses")) {
          return makeQuery(makeSnapshot([
            { id: "course-1", data: { name: "テストコース" } },
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

describe("GET /attendance-report isSynthetic マップ (#533 Phase 3 / #551)", () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const { superAdminRouter } = await import("../../routes/super-admin.js");
    const app = express();
    app.use(express.json());
    app.use(superAdminRouter);
    request = supertest(app);
  }, 30_000);

  it("レスポンスの全 record で isSynthetic が boolean になる (AC1)", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(3);
    for (const record of res.body.records) {
      expect(typeof record.isSynthetic).toBe("boolean");
    }
  });

  it("isSynthetic=true の doc は record.isSynthetic=true (AC1)", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    const synthetic = res.body.records.find((r: { id: string }) => r.id === "synth-session-1");
    expect(synthetic.isSynthetic).toBe(true);
  });

  it("isSynthetic=false の doc は record.isSynthetic=false (AC1)", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    const actual = res.body.records.find((r: { id: string }) => r.id === "actual-session-1");
    expect(actual.isSynthetic).toBe(false);
  });

  it("isSynthetic フィールド欠落の doc は record.isSynthetic=false (AC2: 防御的マップ)", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    const legacy = res.body.records.find((r: { id: string }) => r.id === "legacy-session-1");
    expect(legacy.isSynthetic).toBe(false);
  });
});
