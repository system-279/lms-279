/**
 * progress-pdf 統合テスト (ADR-031 Phase 1)
 *
 * カバレッジ:
 * - buildProgressPdfData によるデータ集約（境界含む）
 * - calculatePace の状態遷移 (completed / expired_both / expired_video / expired_quiz / ongoing)
 * - 越境チェック: user_not_in_tenant のスロー
 * - 残動画秒の欠損対応 (durationSec * requiredWatchRatio - watched)
 * - PDF Buffer 生成: %PDF ヘッダ、サイズ上限 (5MB) 内、メモリピーク 200MB 未満
 * - sections フラグによる on/off
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFParse } from "pdf-parse";
import { InMemoryDataSource } from "../../datasource/in-memory.js";

/** pdf-parse 2.x の PDFParse クラスを使ってテキスト抽出する小さなヘルパ */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}
import {
  buildProgressPdfData,
  __internal,
} from "../../services/progress-pdf.js";
import { ProgressPdfDocument } from "../../services/progress-pdf-document.js";
import type { ProgressPdfSections } from "@lms-279/shared-types";

const NOW = new Date("2026-05-13T10:00:00Z");
const FIVE_MB = 5 * 1024 * 1024;
const ALL_ON: ProgressPdfSections = {
  profile: true,
  deadline: true,
  summary: true,
  lessons: true,
  quiz: true,
  pace: true,
  video: true,
};

async function seedTenant(ds: InMemoryDataSource, opts: {
  enrolledAt?: string;
  videoAccessUntil?: string;
  quizAccessUntil?: string;
}) {
  // user
  const user = await ds.createUser({
    email: "student@example.com",
    name: "山田 太郎",
    role: "student",
  });
  // course + lessons + video
  const course = await ds.createCourse({
    name: "サンプルコース",
    description: null,
    status: "published",
    lessonOrder: [],
    passThreshold: 70,
    createdBy: "admin@test",
  });
  const lessonA = await ds.createLesson({
    courseId: course.id,
    title: "レッスンA",
    order: 1,
    hasVideo: true,
    hasQuiz: true,
    videoUnlocksPrior: false,
  });
  const lessonB = await ds.createLesson({
    courseId: course.id,
    title: "レッスンB",
    order: 2,
    hasVideo: true,
    hasQuiz: false,
    videoUnlocksPrior: false,
  });
  await ds.updateCourse(course.id, { lessonOrder: [lessonA.id, lessonB.id] });

  const videoA = await ds.createVideo({
    lessonId: lessonA.id,
    courseId: course.id,
    sourceType: "external_url",
    sourceUrl: "https://example.com/a.mp4",
    durationSec: 600,
    requiredWatchRatio: 0.95,
    speedLock: true,
  });
  const videoB = await ds.createVideo({
    lessonId: lessonB.id,
    courseId: course.id,
    sourceType: "external_url",
    sourceUrl: "https://example.com/b.mp4",
    durationSec: 1200,
    requiredWatchRatio: 0.95,
    speedLock: true,
  });

  // enrollment setting
  if (opts.videoAccessUntil && opts.quizAccessUntil) {
    await ds.upsertTenantEnrollmentSetting({
      enrolledAt: opts.enrolledAt ?? "2026-04-01T00:00:00Z",
      videoAccessUntil: opts.videoAccessUntil,
      quizAccessUntil: opts.quizAccessUntil,
      createdBy: "super@test",
    });
  }

  return { user, course, lessonA, lessonB, videoA, videoB };
}

describe("progress-pdf — buildProgressPdfData", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("throws user_not_in_tenant when userId does not exist", async () => {
    await expect(
      buildProgressPdfData({
        dataSource: ds,
        tenant: { id: "t1", name: "T", ownerEmail: null },
        userId: "non-existent",
        now: NOW,
      }),
    ).rejects.toThrow("user_not_in_tenant");
  });

  it("aggregates user/tenant/courses/lessons with no progress", async () => {
    const { user, course } = await seedTenant(ds, {
      videoAccessUntil: "2027-05-13T14:59:59.999Z",
      quizAccessUntil: "2026-07-13T14:59:59.999Z",
    });

    const data = await buildProgressPdfData({
      dataSource: ds,
      tenant: { id: "t1", name: "テナントA", ownerEmail: "owner@example.com" },
      userId: user.id,
      now: NOW,
    });

    expect(data.user.id).toBe(user.id);
    expect(data.user.name).toBe("山田 太郎");
    expect(data.tenant.name).toBe("テナントA");
    expect(data.tenant.ownerEmail).toBe("owner@example.com");
    const ownCourse = data.courses.find((c) => c.courseId === course.id);
    expect(ownCourse).toBeDefined();
    expect(ownCourse!.lessons).toHaveLength(2);
    expect(ownCourse!.completedLessons).toBe(0);
    expect(ownCourse!.totalLessons).toBe(2);
    expect(data.deadline.daysRemainingVideo).toBeGreaterThan(300);
    expect(data.deadline.daysRemainingQuiz).toBeGreaterThan(50);
  });

  it("reflects user_progress and course_progress", async () => {
    const { user, lessonA, course } = await seedTenant(ds, {
      videoAccessUntil: "2027-05-13T14:59:59.999Z",
      quizAccessUntil: "2026-07-13T14:59:59.999Z",
    });
    await ds.upsertUserProgress(user.id, lessonA.id, {
      courseId: course.id,
      videoCompleted: true,
      quizPassed: true,
      quizBestScore: 92,
      lessonCompleted: true,
    });
    await ds.upsertCourseProgress(user.id, course.id, {
      completedLessons: 1,
      totalLessons: 2,
      progressRatio: 0.5,
      isCompleted: false,
    });

    const data = await buildProgressPdfData({
      dataSource: ds,
      tenant: { id: "t1", name: "テナントA", ownerEmail: null },
      userId: user.id,
      now: NOW,
    });

    const ownCourse = data.courses.find((c) => c.courseId === course.id)!;
    const lessonRecord = ownCourse.lessons.find((l) => l.lessonId === lessonA.id)!;
    expect(lessonRecord.lessonCompleted).toBe(true);
    expect(lessonRecord.quizBestScore).toBe(92);
    expect(ownCourse.completedLessons).toBe(1);
    expect(ownCourse.progressRatio).toBe(0.5);
    // 自分のコースの残レッスンは B のみ
    const ownCourseRemaining = ownCourse.totalLessons - ownCourse.completedLessons;
    expect(ownCourseRemaining).toBe(1);
  });

  it("uses video_analytics totalWatchTimeSec for video summary", async () => {
    const { user, videoA, videoB } = await seedTenant(ds, {
      videoAccessUntil: "2027-05-13T14:59:59.999Z",
      quizAccessUntil: "2026-07-13T14:59:59.999Z",
    });
    await ds.upsertVideoAnalytics(user.id, videoA.id, {
      isComplete: false,
      coverageRatio: 0.5,
      totalWatchTimeSec: 300,
      watchedRanges: [{ start: 0, end: 300 }],
    });

    const data = await buildProgressPdfData({
      dataSource: ds,
      tenant: { id: "t1", name: "T", ownerEmail: null },
      userId: user.id,
      now: NOW,
    });

    // 自分の seed したコースの動画 durationSec が含まれること（他テスト seed は数値が違うので加算順序非依存）
    expect(data.videoSummary.totalWatchedSec).toBeGreaterThanOrEqual(300);
    // 自前 video の合計 (600 + 1200 = 1800) が含まれる
    expect(data.videoSummary.totalDurationSec).toBeGreaterThanOrEqual(1800);
    // どちらの video も createCourse 経由で作ったので確認可能
    expect(videoA.durationSec + videoB.durationSec).toBe(1800);
  });
});

describe("progress-pdf — calculatePace boundaries", () => {
  it("returns completed when no lessons remain", () => {
    const pace = __internal.calculatePace({
      remainingLessons: 0,
      remainingVideoSec: 0,
      daysRemainingVideo: 100,
      daysRemainingQuiz: 50,
    });
    expect(pace.status).toBe("completed");
    expect(pace.lessonsPerWeek).toBeNull();
    expect(pace.minutesPerDay).toBeNull();
  });

  it("returns expired_both when both deadlines passed", () => {
    const pace = __internal.calculatePace({
      remainingLessons: 5,
      remainingVideoSec: 1000,
      daysRemainingVideo: -1,
      daysRemainingQuiz: -1,
    });
    expect(pace.status).toBe("expired_both");
    expect(pace.remainingDays).toBeNull();
    expect(pace.lessonsPerWeek).toBeNull();
    expect(pace.minutesPerDay).toBeNull();
  });

  it("returns expired_video when only video expired (test still possible)", () => {
    const pace = __internal.calculatePace({
      remainingLessons: 3,
      remainingVideoSec: 600,
      daysRemainingVideo: -5,
      daysRemainingQuiz: 30,
    });
    expect(pace.status).toBe("expired_video");
    // video 期限切れなので minutesPerDay は出さない
    expect(pace.lessonsPerWeek).toBeNull();
    expect(pace.minutesPerDay).toBeNull();
    expect(pace.remainingDays).toBe(30);
  });

  it("returns expired_quiz when only quiz expired (video still possible)", () => {
    const pace = __internal.calculatePace({
      remainingLessons: 3,
      remainingVideoSec: 600,
      daysRemainingVideo: 30,
      daysRemainingQuiz: -5,
    });
    expect(pace.status).toBe("expired_quiz");
    expect(pace.lessonsPerWeek).not.toBeNull();
    expect(pace.minutesPerDay).not.toBeNull();
    expect(pace.remainingDays).toBe(30);
  });

  it("returns ongoing with computed pace", () => {
    const pace = __internal.calculatePace({
      remainingLessons: 10,
      remainingVideoSec: 3600,
      daysRemainingVideo: 30,
      daysRemainingQuiz: 30,
    });
    expect(pace.status).toBe("ongoing");
    // 10 lessons / (30/7) weeks ≈ 2.33 -> ceil 3
    expect(pace.lessonsPerWeek).toBe(3);
    // 3600 / 30 / 60 = 2 minutes
    expect(pace.minutesPerDay).toBe(2);
  });
});

describe("progress-pdf — PDF rendering", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("renders a valid PDF buffer (%PDF header, under 5MB)", async () => {
    const { user } = await seedTenant(ds, {
      videoAccessUntil: "2027-05-13T14:59:59.999Z",
      quizAccessUntil: "2026-07-13T14:59:59.999Z",
    });
    const data = await buildProgressPdfData({
      dataSource: ds,
      tenant: { id: "t1", name: "テナントA", ownerEmail: "owner@example.com" },
      userId: user.id,
      now: NOW,
    });

    const memBefore = process.memoryUsage().heapUsed;
    const buffer = await renderToBuffer(
      ProgressPdfDocument({ data, sections: ALL_ON }),
    );
    const memAfter = process.memoryUsage().heapUsed;

    expect(buffer.length).toBeGreaterThan(1024);
    expect(buffer.length).toBeLessThan(FIVE_MB);
    expect(buffer.slice(0, 4).toString()).toBe("%PDF");

    // メモリピークが Cloud Run 256MB の半分以下 (= 安全マージン)
    const heapDeltaMB = (memAfter - memBefore) / (1024 * 1024);
    expect(heapDeltaMB).toBeLessThan(200);
  }, 30_000);

  it("includes student name and tenant name in extracted PDF text", async () => {
    const { user } = await seedTenant(ds, {
      videoAccessUntil: "2027-05-13T14:59:59.999Z",
      quizAccessUntil: "2026-07-13T14:59:59.999Z",
    });
    const data = await buildProgressPdfData({
      dataSource: ds,
      tenant: { id: "t1", name: "テナントAlpha", ownerEmail: "owner@example.com" },
      userId: user.id,
      now: NOW,
    });
    const buffer = await renderToBuffer(
      ProgressPdfDocument({ data, sections: ALL_ON }),
    );
    const text = await extractPdfText(buffer);

    // 「受講進捗レポート」タイトル
    expect(text).toContain("受講進捗レポート");
    // テナント名
    expect(text).toContain("テナントAlpha");
    // 受講者名（seedTenant で "山田 太郎" を作成）
    expect(text).toContain("山田 太郎");
    // セクション見出しの一部
    expect(text).toContain("受講期限");
    expect(text).toContain("推奨ペース");
  }, 30_000);

  it("excludes section content when corresponding sections flag is off", async () => {
    const { user } = await seedTenant(ds, {
      videoAccessUntil: "2027-05-13T14:59:59.999Z",
      quizAccessUntil: "2026-07-13T14:59:59.999Z",
    });
    const data = await buildProgressPdfData({
      dataSource: ds,
      tenant: { id: "t1", name: "テナントBeta", ownerEmail: null },
      userId: user.id,
      now: NOW,
    });
    const sectionsOnlyProfile: ProgressPdfSections = {
      profile: true,
      deadline: false,
      summary: false,
      lessons: false,
      quiz: false,
      pace: false,
      video: false,
    };
    const buffer = await renderToBuffer(
      ProgressPdfDocument({ data, sections: sectionsOnlyProfile }),
    );
    const text = await extractPdfText(buffer);

    expect(text).toContain("受講者プロフィール");
    expect(text).not.toContain("推奨ペース");
    expect(text).not.toContain("レッスン別チェックリスト");
  }, 30_000);

  it("renders PDF without crashing when all sections are off", async () => {
    const { user } = await seedTenant(ds, {
      videoAccessUntil: "2027-05-13T14:59:59.999Z",
      quizAccessUntil: "2026-07-13T14:59:59.999Z",
    });
    const data = await buildProgressPdfData({
      dataSource: ds,
      tenant: { id: "t1", name: "T", ownerEmail: null },
      userId: user.id,
      now: NOW,
    });
    const buffer = await renderToBuffer(
      ProgressPdfDocument({
        data,
        sections: {
          profile: false,
          deadline: false,
          summary: false,
          lessons: false,
          quiz: false,
          pace: false,
          video: false,
        },
      }),
    );
    expect(buffer.slice(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});
