/**
 * スーパー管理者向け 受講者進捗 PDF 出力 DTO
 * ソース: services/api/src/routes/super/progress-pdf.ts
 *
 * Phase 1: PDF 生成のみ。Phase 2 でメール送信時に再利用予定。
 */

export type ProgressPdfSectionKey =
  | "profile"
  | "deadline"
  | "summary"
  | "lessons"
  | "quiz"
  | "pace"
  | "video";

export type ProgressPdfSections = Record<ProgressPdfSectionKey, boolean>;

export interface ProgressPdfRequest {
  /** Idempotency 用。FE で crypto.randomUUID() を生成して送信 */
  requestId: string;
  /** 各セクションを PDF に含めるかどうか。全 false でも生成自体は成功するが空に近い PDF になる */
  sections: ProgressPdfSections;
}

/**
 * 推奨ペース計算結果。
 *
 * status により意味が変わる:
 * - completed: 全レッスン完了済 (lessonsPerWeek/minutesPerDay は null)
 * - expired_both: 動画もテストも期限切れ (pace 算出不能)
 * - expired_video: 動画期限切れ (lessonsPerWeek=null、minutesPerDay=null)
 * - expired_quiz: テスト期限切れ (動画視聴のみ可能、minutesPerDay は計算可)
 * - ongoing: 両期限内、lessonsPerWeek/minutesPerDay は計算済
 */
export type PaceStatus =
  | "completed"
  | "expired_both"
  | "expired_video"
  | "expired_quiz"
  | "ongoing";

export interface Pace {
  status: PaceStatus;
  remainingLessons: number;
  /** 残り日数。両方期限切れなら null */
  remainingDays: number | null;
  /** 1週間あたり完了すべきレッスン数 (ongoing/expired_quiz でのみ算出) */
  lessonsPerWeek: number | null;
  /** 1日あたりの視聴時間 (分単位、ongoing でのみ算出) */
  minutesPerDay: number | null;
}

export interface ProgressPdfLessonRecord {
  lessonId: string;
  lessonTitle: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
  videoCompleted: boolean;
  quizPassed: boolean;
  quizBestScore: number | null;
  lessonCompleted: boolean;
  /** 動画の総再生時間 (秒)。動画なしレッスンは null */
  videoDurationSec: number | null;
  /** 累計視聴時間 (秒)。analytics 未記録なら null */
  videoWatchedSec: number | null;
}

export interface ProgressPdfCourseRecord {
  courseId: string;
  courseName: string;
  completedLessons: number;
  totalLessons: number;
  progressRatio: number;
  isCompleted: boolean;
  lessons: ProgressPdfLessonRecord[];
}

/**
 * PDF 生成に必要な集約データ。
 * API ルートが progress-pdf-document.tsx に渡す中間表現でもある。
 */
export interface ProgressPdfData {
  generatedAt: string; // ISO timestamp
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  tenant: {
    id: string;
    name: string;
    /** Phase 2 のメール送信宛先。Phase 1 では UI プレビュー表示用 */
    ownerEmail: string | null;
  };
  deadline: {
    enrolledAt: string | null;
    deadlineBaseDate: string | null;
    videoAccessUntil: string | null;
    quizAccessUntil: string | null;
    daysRemainingVideo: number | null;
    daysRemainingQuiz: number | null;
  };
  courses: ProgressPdfCourseRecord[];
  pace: Pace;
  videoSummary: {
    totalWatchedSec: number;
    totalDurationSec: number;
  };
}
