/**
 * スーパー管理者向け 受講者進捗 PDF 用データ集約サービス。
 *
 * tenant 単位の DataSource と、tenant 外部の docName/ownerEmail を受け取り、
 * `@lms-279/shared-types` の `ProgressPdfData` を構築する。
 *
 * pace 計算境界仕様（ADR-031）:
 * - completed:      全レッスン完了済
 * - expired_both:   videoAccessUntil/quizAccessUntil 双方が現在時刻以前
 * - expired_video:  動画期限切れ（テストのみ受験可。pace 数値は null）
 * - expired_quiz:   テスト期限切れ（動画視聴のみ可。lessonsPerWeek/minutesPerDay は計算可）
 * - ongoing:        両期限内
 */

import type {
  Pace,
  PaceStatus,
  ProgressPdfCourseRecord,
  ProgressPdfData,
  ProgressPdfLessonRecord,
} from "@lms-279/shared-types";
import type { DataSource } from "../datasource/interface.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** lesson ごとの video/analytics 並列取得上限 (Firestore 詰まり回避) */
const LESSON_FETCH_CONCURRENCY = 8;

/** Promise を chunk 単位で並列実行する小さなランナー (外部依存を増やさない) */
async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    const sliceResults = await Promise.all(slice.map(fn));
    for (let j = 0; j < sliceResults.length; j++) {
      results[i + j] = sliceResults[j];
    }
  }
  return results;
}

export interface TenantInfo {
  id: string;
  name: string;
  ownerEmail: string | null;
}

export interface BuildProgressPdfDataInput {
  dataSource: DataSource;
  tenant: TenantInfo;
  userId: string;
  /** 現在時刻。テストで固定できるよう注入可能。未指定なら `new Date()` */
  now?: Date;
}

/**
 * 残り日数（小数切り捨て）。負値ありで返す（期限切れ判定に使う）。
 */
function diffDays(deadlineIso: string | null, now: Date): number | null {
  if (!deadlineIso) return null;
  const deadline = new Date(deadlineIso);
  if (Number.isNaN(deadline.getTime())) return null;
  return Math.floor((deadline.getTime() - now.getTime()) / MS_PER_DAY);
}

function calculatePace(args: {
  remainingLessons: number;
  remainingVideoSec: number;
  daysRemainingVideo: number | null;
  daysRemainingQuiz: number | null;
}): Pace {
  const { remainingLessons, remainingVideoSec, daysRemainingVideo, daysRemainingQuiz } = args;

  const videoExpired = daysRemainingVideo != null && daysRemainingVideo < 0;
  const quizExpired = daysRemainingQuiz != null && daysRemainingQuiz < 0;

  // 「両方期限切れ」または「設定が片方しかなく、その片方が切れている」
  const bothExpired = videoExpired && quizExpired;

  // 残り日数 = 残っている期限のうち最も近いもの（両方期限内なら min）
  const candidates = [daysRemainingVideo, daysRemainingQuiz].filter(
    (d): d is number => d != null && d >= 0,
  );
  const remainingDays = candidates.length > 0 ? Math.min(...candidates) : null;

  let status: PaceStatus;
  if (remainingLessons === 0) {
    status = "completed";
  } else if (bothExpired) {
    status = "expired_both";
  } else if (videoExpired) {
    status = "expired_video";
  } else if (quizExpired) {
    status = "expired_quiz";
  } else {
    status = "ongoing";
  }

  let lessonsPerWeek: number | null = null;
  let minutesPerDay: number | null = null;

  if (status === "ongoing" || status === "expired_quiz") {
    // 動画視聴可なので lessonsPerWeek / minutesPerDay とも計算する
    if (remainingDays != null && remainingDays > 0) {
      lessonsPerWeek = Math.max(1, Math.ceil(remainingLessons / (remainingDays / 7)));
      minutesPerDay = Math.max(1, Math.ceil(remainingVideoSec / remainingDays / 60));
    } else if (remainingDays === 0 && remainingLessons > 0) {
      // 当日中に終わらせる必要がある（実用上稀）
      lessonsPerWeek = remainingLessons * 7;
      minutesPerDay = Math.ceil(remainingVideoSec / 60);
    }
  }

  return {
    status,
    remainingLessons,
    remainingDays,
    lessonsPerWeek,
    minutesPerDay,
  };
}

/**
 * tenant の特定 user の進捗を PDF 用に集約する。
 *
 * @throws Error user 不在（呼び出し側で 404 にマップする）
 */
export async function buildProgressPdfData(
  input: BuildProgressPdfDataInput,
): Promise<ProgressPdfData> {
  const { dataSource, tenant, userId } = input;
  const now = input.now ?? new Date();

  // user 存在確認（DataSource は tenant scope なので越境ユーザーは null になる）
  const user = await dataSource.getUserById(userId);
  if (!user) {
    throw new Error("user_not_in_tenant");
  }

  // PDF には公開済みコースのみを載せる (draft / archived は受講者に表示すべきでない)
  const [enrollmentSetting, courses, lessons, courseProgresses] = await Promise.all([
    dataSource.getTenantEnrollmentSetting(),
    dataSource.getCourses({ status: "published" }),
    dataSource.getLessons(),
    dataSource.getCourseProgressByUser(userId),
  ]);

  const courseProgressById = new Map(courseProgresses.map((cp) => [cp.courseId, cp]));
  const lessonsByCourse = new Map<string, typeof lessons>();
  for (const lesson of lessons) {
    const arr = lessonsByCourse.get(lesson.courseId) ?? [];
    arr.push(lesson);
    lessonsByCourse.set(lesson.courseId, arr);
  }

  // course ごとに lesson → video → analytics → user_progress を集約
  const courseRecords: ProgressPdfCourseRecord[] = [];
  let totalRemainingLessons = 0;
  let totalRemainingVideoSec = 0;
  let totalWatchedSec = 0;
  let totalDurationSec = 0;

  for (const course of courses) {
    const orderedLessonIds = course.lessonOrder ?? [];
    const courseLessons = lessonsByCourse.get(course.id) ?? [];
    const lessonById = new Map(courseLessons.map((l) => [l.id, l]));

    // lessonOrder にあるが lessons 取得に失敗したものは飛ばす（マスタ不整合）
    const validLessonIds = orderedLessonIds.filter((id) => lessonById.has(id));

    const [userProgresses, videos] = await Promise.all([
      dataSource.getUserProgressByCourse(userId, course.id),
      runInBatches(validLessonIds, LESSON_FETCH_CONCURRENCY, (lid) =>
        dataSource.getVideoByLessonId(lid),
      ),
    ]);
    const userProgressByLesson = new Map(userProgresses.map((up) => [up.lessonId, up]));
    const videoByLessonId = new Map<string, typeof videos[number]>();
    validLessonIds.forEach((lid, idx) => videoByLessonId.set(lid, videos[idx]));

    const analyticsResults = await runInBatches(
      validLessonIds,
      LESSON_FETCH_CONCURRENCY,
      (lid) => {
        const video = videoByLessonId.get(lid);
        return video
          ? dataSource.getVideoAnalytics(userId, video.id)
          : Promise.resolve(null);
      },
    );
    const analyticsByLessonId = new Map<string, typeof analyticsResults[number]>();
    validLessonIds.forEach((lid, idx) => analyticsByLessonId.set(lid, analyticsResults[idx]));

    const lessonRecords: ProgressPdfLessonRecord[] = validLessonIds.map((lid, idx) => {
      const lesson = lessonById.get(lid)!;
      const up = userProgressByLesson.get(lid);
      const video = videoByLessonId.get(lid);
      const analytics = analyticsByLessonId.get(lid);

      const videoDurationSec = video?.durationSec ?? null;
      const videoWatchedSec = analytics?.totalWatchTimeSec ?? null;

      // 残り未視聴秒（requiredWatchRatio=0.95 を達成するために必要な分）
      if (videoDurationSec != null) {
        totalDurationSec += videoDurationSec;
        if (videoWatchedSec != null) totalWatchedSec += videoWatchedSec;
        if (!(up?.videoCompleted ?? false)) {
          const required = videoDurationSec * (video?.requiredWatchRatio ?? 0.95);
          const watched = videoWatchedSec ?? 0;
          totalRemainingVideoSec += Math.max(0, required - watched);
        }
      }

      return {
        lessonId: lid,
        lessonTitle: lesson.title,
        order: lesson.order ?? idx,
        hasVideo: lesson.hasVideo,
        hasQuiz: lesson.hasQuiz,
        videoCompleted: up?.videoCompleted ?? false,
        quizPassed: up?.quizPassed ?? false,
        quizBestScore: up?.quizBestScore ?? null,
        lessonCompleted: up?.lessonCompleted ?? false,
        videoDurationSec,
        videoWatchedSec,
      };
    });

    const cp = courseProgressById.get(course.id);
    const completedLessons = cp?.completedLessons ?? lessonRecords.filter((l) => l.lessonCompleted).length;
    const totalLessons = cp?.totalLessons ?? lessonRecords.length;
    totalRemainingLessons += Math.max(0, totalLessons - completedLessons);

    courseRecords.push({
      courseId: course.id,
      courseName: course.name,
      completedLessons,
      totalLessons,
      progressRatio: cp?.progressRatio ?? (totalLessons > 0 ? completedLessons / totalLessons : 0),
      isCompleted: cp?.isCompleted ?? false,
      lessons: lessonRecords,
    });
  }

  const videoUntil = enrollmentSetting?.videoAccessUntil ?? null;
  const quizUntil = enrollmentSetting?.quizAccessUntil ?? null;
  const daysRemainingVideo = diffDays(videoUntil, now);
  const daysRemainingQuiz = diffDays(quizUntil, now);

  const pace = calculatePace({
    remainingLessons: totalRemainingLessons,
    remainingVideoSec: totalRemainingVideoSec,
    daysRemainingVideo,
    daysRemainingQuiz,
  });

  return {
    generatedAt: now.toISOString(),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
    tenant: {
      id: tenant.id,
      name: tenant.name,
      ownerEmail: tenant.ownerEmail,
    },
    deadline: {
      enrolledAt: enrollmentSetting?.enrolledAt ?? null,
      deadlineBaseDate: enrollmentSetting?.deadlineBaseDate ?? null,
      videoAccessUntil: videoUntil,
      quizAccessUntil: quizUntil,
      daysRemainingVideo,
      daysRemainingQuiz,
    },
    courses: courseRecords,
    pace,
    videoSummary: {
      totalWatchedSec,
      totalDurationSec,
    },
  };
}

export const __internal = { calculatePace, diffDays };
