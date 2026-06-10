/**
 * PATCH /attendance-report/:sessionId の original snapshot 保存ロジックと
 * GET レスポンスの original / editedAt 返却を検証する。
 *
 * Issue #556: 編集時に元データを immutable snapshot として保持する。
 *   - 初回 PATCH: original 未設定 → 現在値を snapshot 保存 + editedAt 記録
 *   - 2 回目以降 PATCH: original 不変 (immutable)、editedAt のみ更新
 *   - 既存データ (original 欠落): GET レスポンスで undefined を返す
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import supertest from "supertest";
import express from "express";

// PATCH 経由で update が呼ばれた引数を記録するための spy
const sessionUpdateSpy = vi.fn(() => Promise.resolve());
const attemptUpdateSpy = vi.fn(() => Promise.resolve());

// session ドキュメントの可変状態（テストごとに beforeEach でリセット）
type SessionDocState = {
  exists: boolean;
  data: Record<string, unknown>;
};
let sessionDocState: SessionDocState;

// quiz_attempts ドキュメントの可変状態
let attemptDocState: SessionDocState;

// GET レスポンス用 lesson_sessions snapshot
let sessionsSnapshotDocs: { id: string; data: Record<string, unknown> }[] = [];

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

vi.mock("firebase-admin/firestore", () => ({
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
        return {
          orderBy: vi.fn(() => ({
            where: vi.fn(function (this: unknown) {
              return this;
            }),
            get: vi.fn(() => Promise.resolve(makeSnapshot(sessionsSnapshotDocs))),
          })),
          doc: vi.fn(() => ({
            get: vi.fn(() => Promise.resolve({
              exists: sessionDocState.exists,
              data: () => sessionDocState.data,
            })),
            update: sessionUpdateSpy,
          })),
        };
      }
      if (path.endsWith("/quiz_attempts")) {
        return {
          doc: vi.fn(() => ({
            get: vi.fn(() => Promise.resolve({
              exists: attemptDocState.exists,
              data: () => attemptDocState.data,
            })),
            update: attemptUpdateSpy,
          })),
          where: vi.fn(() => ({
            get: vi.fn(() => Promise.resolve(makeSnapshot([]))),
          })),
        };
      }
      if (path.endsWith("/users") || path.endsWith("/lessons") || path.endsWith("/courses")) {
        return makeQuery(makeSnapshot([]));
      }
      return makeQuery(makeSnapshot([]));
    }),
  })),
}));

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

describe("PATCH original snapshot 保存 (#556 Issue)", () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const { superAdminRouter } = await import("../../routes/super-admin.js");
    const app = express();
    app.use(express.json());
    app.use(superAdminRouter);
    request = supertest(app);
  }, 30_000);

  beforeEach(() => {
    sessionUpdateSpy.mockClear();
    attemptUpdateSpy.mockClear();
  });

  it("AC1: 初回編集時 → 現在値を original snapshot として保存 + editedAt 記録", async () => {
    sessionDocState = {
      exists: true,
      data: {
        userId: "user-1",
        entryAt: "2026-06-09T01:00:00.000Z",
        exitAt: "2026-06-09T01:30:00.000Z",
        quizScore: 100,
        quizPassed: true,
        quizAttemptId: "attempt-1",
        // original 未設定
      },
    };
    attemptDocState = { exists: false, data: {} };

    const res = await request
      .patch("/tenants/test-tenant/attendance-report/sess-1")
      .send({ entryAt: "2026-06-09T01:00:00.000Z", exitAt: "2026-06-09T01:45:00.000Z" });

    expect(res.status).toBe(200);
    expect(sessionUpdateSpy).toHaveBeenCalled();
    const updateArg = sessionUpdateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg.original).toEqual({
      entryAt: "2026-06-09T01:00:00.000Z",
      exitAt: "2026-06-09T01:30:00.000Z",
      quizScore: 100,
      quizPassed: true,
    });
    expect(typeof updateArg.editedAt).toBe("string");
    expect(updateArg.exitAt).toBe("2026-06-09T01:45:00.000Z");
  });

  it("AC2: 2 回目以降 PATCH → original を更新フィールドに含めない (immutable)、editedAt のみ更新", async () => {
    sessionDocState = {
      exists: true,
      data: {
        userId: "user-1",
        entryAt: "2026-06-09T02:00:00.000Z",
        exitAt: "2026-06-09T02:30:00.000Z",
        original: {
          entryAt: "2026-06-09T01:00:00.000Z",
          exitAt: "2026-06-09T01:30:00.000Z",
          quizScore: 80,
          quizPassed: true,
        },
        editedAt: "2026-06-09T10:00:00.000Z",
      },
    };
    attemptDocState = { exists: false, data: {} };

    const res = await request
      .patch("/tenants/test-tenant/attendance-report/sess-2")
      .send({ exitAt: "2026-06-09T02:45:00.000Z" });

    expect(res.status).toBe(200);
    const updateArg = sessionUpdateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect("original" in updateArg).toBe(false);
    expect(typeof updateArg.editedAt).toBe("string");
    expect(updateArg.editedAt).not.toBe("2026-06-09T10:00:00.000Z");
  });

  it("Evaluator 指摘: original=null の doc は初回扱い (== null 判定で undefined と null 両対応)", async () => {
    sessionDocState = {
      exists: true,
      data: {
        userId: "user-1",
        entryAt: "2026-06-09T01:00:00.000Z",
        exitAt: "2026-06-09T01:30:00.000Z",
        original: null, // 手動 null 直書きされたケース
      },
    };
    attemptDocState = { exists: false, data: {} };

    const res = await request
      .patch("/tenants/test-tenant/attendance-report/sess-null")
      .send({ exitAt: "2026-06-09T01:45:00.000Z" });

    expect(res.status).toBe(200);
    const updateArg = sessionUpdateSpy.mock.calls[0][0] as Record<string, unknown>;
    // null の場合も初回扱いで snapshot が保存される (Evaluator 検出: === undefined のみだとすり抜ける)
    expect(updateArg.original).toBeDefined();
  });

  it("Evaluator 指摘: quizAttemptId なし + quiz 値 null の初回 PATCH → snapshot の quiz 値は null のまま保存", async () => {
    sessionDocState = {
      exists: true,
      data: {
        userId: "user-1",
        entryAt: "2026-06-09T01:00:00.000Z",
        exitAt: "2026-06-09T01:30:00.000Z",
        // quizAttemptId なし、quizScore/quizPassed も未設定
      },
    };
    attemptDocState = { exists: false, data: {} };

    const res = await request
      .patch("/tenants/test-tenant/attendance-report/sess-no-quiz")
      .send({ entryAt: "2026-06-09T00:30:00.000Z" });

    expect(res.status).toBe(200);
    const updateArg = sessionUpdateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg.original).toEqual({
      entryAt: "2026-06-09T01:00:00.000Z",
      exitAt: "2026-06-09T01:30:00.000Z",
      quizScore: null,
      quizPassed: null,
    });
  });

  it("AC1 拡張: session に quiz 値なし + quiz_attempts に値あり → attempt から fallback 取得して snapshot", async () => {
    sessionDocState = {
      exists: true,
      data: {
        userId: "user-1",
        entryAt: "2026-06-09T03:00:00.000Z",
        exitAt: "2026-06-09T03:15:00.000Z",
        quizAttemptId: "attempt-2",
      },
    };
    attemptDocState = {
      exists: true,
      data: { score: 90, isPassed: true },
    };

    const res = await request
      .patch("/tenants/test-tenant/attendance-report/sess-3")
      .send({ exitAt: "2026-06-09T03:30:00.000Z" });

    expect(res.status).toBe(200);
    const updateArg = sessionUpdateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg.original).toEqual({
      entryAt: "2026-06-09T03:00:00.000Z",
      exitAt: "2026-06-09T03:15:00.000Z",
      quizScore: 90,
      quizPassed: true,
    });
  });
});

describe("GET /attendance-report レスポンスの original/editedAt 返却 (#556)", () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const { superAdminRouter } = await import("../../routes/super-admin.js");
    const app = express();
    app.use(express.json());
    app.use(superAdminRouter);
    request = supertest(app);
  }, 30_000);

  it("AC3: 編集済 doc (original あり) → レスポンスに original + editedAt が含まれる", async () => {
    sessionsSnapshotDocs = [{
      id: "sess-edited",
      data: {
        userId: "user-1",
        courseId: "course-1",
        lessonId: "lesson-1",
        entryAt: "2026-06-09T05:00:00.000Z",
        exitAt: "2026-06-09T05:30:00.000Z",
        status: "completed",
        original: {
          entryAt: "2026-06-09T04:00:00.000Z",
          exitAt: "2026-06-09T04:05:00.000Z",
          quizScore: 100,
          quizPassed: true,
        },
        editedAt: "2026-06-09T20:00:00.000Z",
      },
    }];

    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(res.status).toBe(200);
    const record = res.body.records[0];
    expect(record.original).toEqual({
      entryAt: "2026-06-09T04:00:00.000Z",
      exitAt: "2026-06-09T04:05:00.000Z",
      quizScore: 100,
      quizPassed: true,
    });
    expect(record.editedAt).toBe("2026-06-09T20:00:00.000Z");
  });

  it("AC4: 未編集 doc (original 欠落) → レスポンスで original / editedAt は undefined", async () => {
    sessionsSnapshotDocs = [{
      id: "sess-unedited",
      data: {
        userId: "user-1",
        courseId: "course-1",
        lessonId: "lesson-1",
        entryAt: "2026-06-09T06:00:00.000Z",
        exitAt: "2026-06-09T06:30:00.000Z",
        status: "completed",
        // original / editedAt 欠落
      },
    }];

    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(res.status).toBe(200);
    const record = res.body.records[0];
    expect(record.original).toBeUndefined();
    expect(record.editedAt).toBeUndefined();
  });
});
