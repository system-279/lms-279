/**
 * GET /admin/analytics/attendance/courses/:courseId と CSV エクスポートの
 * anomalies マップ検証（F2、ADR-027）。
 *
 * super レポート（attendance-report-anomaly.test.ts）は生 Firestore doc 経由で
 * detectSessionAnomalies() を呼ぶ super-admin.ts をテスト済みだが、admin レポート
 * （shared/analytics.ts の buildAttendanceRecords）は LessonSession エンティティ経由の
 * 別入力形状かつコース内スコープのみで判定するため、独立して検証する。
 */

import { describe, it, expect, beforeAll } from "vitest";
import supertest from "supertest";
import { createTestApp } from "../helpers/create-app.js";
import type { InMemoryDataSource } from "../../datasource/in-memory.js";
import type { LessonSession } from "../../types/entities.js";

function baseSessionFields(
  courseId: string,
  overrides: Partial<Omit<LessonSession, "id" | "createdAt" | "updatedAt">>
) {
  return {
    userId: "user-1",
    lessonId: "lesson-1",
    courseId,
    videoId: "video-1",
    sessionToken: "token-1",
    status: "completed" as const,
    entryAt: "2026-06-09T01:00:00.000Z",
    exitAt: "2026-06-09T01:30:00.000Z",
    exitReason: "quiz_submitted" as const,
    deadlineAt: "2026-06-09T03:00:00.000Z",
    pauseStartedAt: null,
    longestPauseSec: 0,
    sessionVideoCompleted: true,
    quizAttemptId: null,
    isSynthetic: false,
    ...overrides,
  };
}

describe("GET /admin/analytics/attendance/courses/:courseId anomalies (F2, ADR-027)", () => {
  let request: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let courseId: string;
  let otherCourseId: string;

  beforeAll(async () => {
    const created = createTestApp();
    request = supertest(created.app);
    ds = created.ds;

    const course = await ds.createCourse({
      name: "異常検知テスト用コース",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 60,
      createdBy: "test-admin",
    });
    courseId = course.id;
    const otherCourse = await ds.createCourse({
      name: "別コース",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 60,
      createdBy: "test-admin",
    });
    otherCourseId = otherCourse.id;

    // overlap_previous: session-b の entryAt が session-a の exitAt より前
    await ds.createLessonSessionWithId("session-a", baseSessionFields(courseId, {
      lessonId: "lesson-1",
      entryAt: "2026-06-09T01:00:00.000Z",
      exitAt: "2026-06-09T01:30:00.000Z",
    }));
    await ds.createLessonSessionWithId("session-b", baseSessionFields(courseId, {
      lessonId: "lesson-2",
      entryAt: "2026-06-09T01:15:00.000Z",
      exitAt: "2026-06-09T02:00:00.000Z",
    }));
    // negative_duration
    await ds.createLessonSessionWithId("session-c", baseSessionFields(courseId, {
      lessonId: "lesson-3",
      status: "force_exited",
      exitReason: "time_limit",
      entryAt: "2026-06-09T03:00:00.000Z",
      exitAt: "2026-06-09T02:00:00.000Z",
    }));
    // synthetic は overlap 検知から除外される → 後続セッションを巻き込まない
    await ds.createLessonSessionWithId("session-d-synthetic", baseSessionFields(courseId, {
      lessonId: "lesson-4",
      entryAt: "2026-06-09T04:00:00.000Z",
      exitAt: "2026-06-09T05:00:00.000Z",
      isSynthetic: true,
    }));
    await ds.createLessonSessionWithId("session-e", baseSessionFields(courseId, {
      lessonId: "lesson-5",
      entryAt: "2026-06-09T04:30:00.000Z",
      exitAt: "2026-06-09T04:45:00.000Z",
    }));
    // 別コース: admin レポートはコース内のみで判定するため、
    // otherCourseId 側とは overlap しても検知されない
    await ds.createLessonSessionWithId("session-other-course", baseSessionFields(otherCourseId, {
      lessonId: "lesson-x",
      entryAt: "2026-06-09T01:10:00.000Z",
      exitAt: "2026-06-09T01:50:00.000Z",
    }));
  });

  function findRecord(body: { records: { sessionId: string; anomalies?: string[] }[] }, sessionId: string) {
    const record = body.records.find((r) => r.sessionId === sessionId);
    if (!record) throw new Error(`record ${sessionId} not found`);
    return record;
  }

  it("後発の重複セッションのみ overlap_previous を持つ", async () => {
    const res = await request.get(`/admin/analytics/attendance/courses/${courseId}`);
    expect(res.status).toBe(200);
    expect(findRecord(res.body, "session-a").anomalies).toBeUndefined();
    expect(findRecord(res.body, "session-b").anomalies).toEqual(["overlap_previous"]);
  });

  it("exitAt < entryAt のセッションは negative_duration を持つ", async () => {
    const res = await request.get(`/admin/analytics/attendance/courses/${courseId}`);
    expect(findRecord(res.body, "session-c").anomalies).toEqual(["negative_duration"]);
  });

  it("synthetic session は overlap 検知から除外され、後続セッションも巻き込まれない", async () => {
    const res = await request.get(`/admin/analytics/attendance/courses/${courseId}`);
    expect(findRecord(res.body, "session-d-synthetic").anomalies).toBeUndefined();
    expect(findRecord(res.body, "session-e").anomalies).toBeUndefined();
  });

  it("他コースのセッションは異常検知の対象に含まれない（コース内スコープ）", async () => {
    const res = await request.get(`/admin/analytics/attendance/courses/${courseId}`);
    const ids = res.body.records.map((r: { sessionId: string }) => r.sessionId);
    expect(ids).not.toContain("session-other-course");
  });

  it("CSV エクスポートに「異常」列が追加され、異常のあるセッションのみラベルが入る", async () => {
    const res = await request.get(`/admin/analytics/attendance/export/courses/${courseId}`);
    expect(res.status).toBe(200);
    const csv = res.text;
    expect(csv).toContain("異常");
    // session-b (overlap_previous) の行に「重複」ラベルが入る
    const bLine = csv.split("\n").find((l) => l.includes("2026-06-09T01:15"));
    expect(bLine).toBeDefined();
    expect(bLine).toContain("重複");
    // session-a (異常なし) の行には異常ラベルが入らない
    const aLine = csv.split("\n").find((l) => l.includes("2026-06-09T01:00"));
    expect(aLine).toBeDefined();
    expect(aLine).not.toContain("重複");
    expect(aLine).not.toContain("負滞在");
    expect(aLine).not.toContain("放置");
  });
});
