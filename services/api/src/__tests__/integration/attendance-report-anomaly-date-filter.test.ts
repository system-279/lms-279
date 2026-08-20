/**
 * GET /attendance-report の from/to 日付フィルタが異常検知に与える影響の検証（F2、ADR-027）。
 *
 * pr-review-toolkit code-reviewer 指摘: overlap 検知は対象ユーザーの全期間セッション履歴が
 * 必要（entryAt 昇順スイープで maxExitSoFar を積み上げるため）。from/to で表示行を絞り込んだ
 * 集合だけを検知にも使うと、範囲外にある重複相手セッションが原因で偽陰性（見逃し）が発生する。
 * super-admin.ts はこれを避けるため、from/to 指定時は検知専用に絞り込み前の全件を別途取得する。
 *
 * このモックハーネスは attendance-report-synthetic.test.ts / attendance-report-anomaly.test.ts と
 * 異なり、`where("entryAt", ">=" | "<=", value)` を実際にフィルタするため、表示行の絞り込みと
 * 検知範囲の違いを検証できる。日付は from/to の JST↔UTC 変換オフセット（実装依存・TZ非依存にはできない
 * `new Date(string-without-Z)` のローカル解釈）による1日程度のズレの影響を受けないよう、
 * 十分な間隔（約1ヶ月）を空けて設定する。
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import supertest from "supertest";
import express from "express";

// session-old は 5 月、session-new は 6 月（重複あり: session-new の entryAt は session-old の exitAt より前）。
// from を 5 月と 6 月の間に設定すると、表示行から session-old は除外されるが、
// 検知は絞り込み前の全件で行われるため session-new の overlap_previous は維持されるはず。
const SESSIONS_FIXTURE = [
  {
    id: "session-old",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-1",
      entryAt: "2026-05-01T01:00:00.000Z",
      exitAt: "2026-06-01T10:00:00.000Z", // 長時間セッション。session-new の entryAt より後まで続く
      exitReason: "quiz_submitted",
      status: "completed",
      isSynthetic: false,
    },
  },
  {
    id: "session-new",
    data: {
      userId: "user-1",
      courseId: "course-1",
      lessonId: "lesson-2",
      entryAt: "2026-06-01T05:00:00.000Z", // session-old の exitAt (06-01T10:00) より前 → overlap
      exitAt: "2026-06-01T11:00:00.000Z",
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

/** where("entryAt", ">=" | "<=", iso) を実際にフィルタする最小限のクエリモック。 */
function makeFilterableLessonSessionsQuery() {
  let filtered = SESSIONS_FIXTURE;
  const queryObj: Record<string, unknown> = {
    orderBy: vi.fn(() => queryObj),
    where: vi.fn((field: string, op: string, value: string) => {
      if (field === "entryAt") {
        filtered = filtered.filter((d) => {
          const entryAt = String(d.data.entryAt);
          return op === ">=" ? entryAt >= value : entryAt <= value;
        });
      }
      return queryObj;
    }),
    get: vi.fn(() => Promise.resolve(makeSnapshot(filtered))),
  };
  return queryObj;
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
        // 呼び出しごとに新しいフィルタ状態を持つクエリを返す
        // （表示用クエリと検知用の全件取得クエリを区別するため、毎回リセットされる必要がある）。
        if (path.endsWith("/lesson_sessions")) {
          return makeFilterableLessonSessionsQuery();
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
          ]));
        }
        if (path.endsWith("/courses")) {
          return makeQuery(makeSnapshot([
            { id: "course-1", data: { name: "コース1" } },
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

describe("GET /attendance-report: from/to 日付フィルタと異常検知の独立性 (F2, ADR-027)", () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const { superAdminRouter } = await import("../../routes/super-admin.js");
    const app = express();
    app.use(express.json());
    app.use(superAdminRouter);
    request = supertest(app);
  }, 30_000);

  it("日付フィルタなしでは両方表示され、session-new が overlap_previous を持つ", async () => {
    const res = await request.get("/tenants/test-tenant/attendance-report");
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(2);
    const newRecord = res.body.records.find((r: { id: string }) => r.id === "session-new");
    expect(newRecord.anomalies).toEqual(["overlap_previous"]);
  });

  it("日付フィルタで重複相手(session-old)が表示範囲外に除外されても、session-new の overlap_previous は検知され続ける", async () => {
    const res = await request
      .get("/tenants/test-tenant/attendance-report")
      .query({ from: "2026-05-20" });

    expect(res.status).toBe(200);
    const ids = res.body.records.map((r: { id: string }) => r.id);
    // このテストの前提（フィルタが実際に session-old を除外していること）を確認
    expect(ids).not.toContain("session-old");
    expect(ids).toContain("session-new");

    const newRecord = res.body.records.find((r: { id: string }) => r.id === "session-new");
    // 表示範囲から重複相手が消えても、異常検知自体は全期間データに基づくため維持される
    expect(newRecord.anomalies).toEqual(["overlap_previous"]);
  });
});
