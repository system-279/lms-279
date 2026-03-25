/**
 * エンティティの型定義
 * DataSource抽象化のための共通型
 */

export type UserRole = "admin" | "teacher" | "student";
export type NotificationScope = "global" | "course" | "user";
export type CourseStatus = "draft" | "published" | "archived";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  firebaseUid?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AllowedEmail {
  id: string;
  email: string;
  note: string | null;
  createdAt: Date;
}

export interface UserSettings {
  userId: string;
  notificationEnabled: boolean;
  timezone: string;
  updatedAt: Date;
}

export interface NotificationPolicy {
  id: string;
  scope: NotificationScope;
  courseId: string | null;
  userId: string | null;
  firstNotifyAfterMin: number;
  repeatIntervalHours: number;
  maxRepeatDays: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthErrorLog {
  id: string;
  email: string;
  tenantId: string;
  errorType: string;
  errorMessage: string;
  path: string;
  method: string;
  userAgent: string | null;
  ipAddress: string | null;
  occurredAt: Date;
}

export interface Course {
  id: string;
  name: string;
  description: string | null;
  status: CourseStatus;
  lessonOrder: string[];
  passThreshold: number;
  createdBy: string;
  sourceMasterCourseId?: string;
  copiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
  videoUnlocksPrior: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface LessonFilter {
  courseId?: string;
}

export interface CourseFilter {
  status?: CourseStatus;
}

export interface NotificationPolicyFilter {
  scope?: NotificationScope;
  courseId?: string;
  userId?: string;
}

// ========================================
// 動画関連
// ========================================

export type VideoSourceType = "gcs" | "external_url" | "google_drive";
export type VideoImportStatus = "pending" | "importing" | "completed" | "error";

export interface Video {
  id: string;
  lessonId: string;
  courseId: string;
  sourceType: VideoSourceType;
  sourceUrl?: string;       // sourceType=external_url時
  gcsPath?: string;         // sourceType=gcs or google_drive(コピー後)時
  driveFileId?: string;     // sourceType=google_drive時: 元のDriveファイルID
  importStatus?: VideoImportStatus; // google_drive: pending→importing→completed|error
  importError?: string;     // importStatus=error時のエラーメッセージ
  durationSec: number;
  requiredWatchRatio: number; // default 0.95
  speedLock: boolean;         // default true
  createdAt: string;
  updatedAt: string;
}

export type VideoEventType =
  | "play"
  | "pause"
  | "seek"
  | "ended"
  | "heartbeat"
  | "ratechange"
  | "visibility_hidden"
  | "visibility_visible";

export interface VideoEvent {
  id: string;
  videoId: string;
  userId: string;
  sessionToken: string;
  eventType: VideoEventType;
  position: number;
  seekFrom?: number;
  playbackRate: number;
  timestamp: string;
  clientTimestamp: number;
  metadata?: Record<string, unknown>;
}

export interface WatchedRange {
  start: number;
  end: number;
}

export type SuspiciousFlag =
  | "excessive_seeks"        // seekCount > 10
  | "no_pauses_long_session" // 一時停止なしの長時間視聴
  | "background_playback"    // タブ非表示中の再生
  | "speed_violation"        // 倍速違反
  | "position_jump";         // heartbeat間の不自然な位置移動

export interface VideoAnalytics {
  id: string;              // userId_videoId
  videoId: string;
  userId: string;
  watchedRanges: WatchedRange[];
  totalWatchTimeSec: number;
  coverageRatio: number;   // 0-1
  isComplete: boolean;
  seekCount: number;
  pauseCount: number;
  totalPauseDurationSec: number;
  speedViolationCount: number;
  suspiciousFlags: SuspiciousFlag[];
  updatedAt: string;
}

export interface VideoFilter {
  lessonId?: string;
  courseId?: string;
}

export interface VideoEventFilter {
  videoId?: string;
  userId?: string;
  sessionToken?: string;
}

// ========================================
// テスト関連
// ========================================

export type QuestionType = "single" | "multi";

export interface QuizOption {
  id: string;
  text: string;
  isCorrect: boolean;
}

export interface QuizQuestion {
  id: string;
  text: string;
  type: QuestionType;
  options: QuizOption[];
  points: number;
  explanation: string;
}

export interface Quiz {
  id: string;
  lessonId: string;
  courseId: string;
  title: string;
  passThreshold: number;      // default 70 (%)
  maxAttempts: number;         // default 3
  timeLimitSec: number | null; // null = 無制限
  randomizeQuestions: boolean;
  randomizeAnswers: boolean;
  requireVideoCompletion: boolean; // default true
  questions: QuizQuestion[];   // 上限50問、埋め込み（ADR-016）
  createdAt: string;
  updatedAt: string;
}

export type QuizAttemptStatus = "in_progress" | "submitted" | "timed_out";

export interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  attemptNumber: number;
  status: QuizAttemptStatus;
  answers: Record<string, string[]>; // { questionId: optionIds[] }
  score: number | null;              // % (0-100), null if not yet scored
  isPassed: boolean | null;
  startedAt: string;
  submittedAt: string | null;
}

export interface QuizFilter {
  lessonId?: string;
  courseId?: string;
}

export interface QuizAttemptFilter {
  quizId?: string;
  userId?: string;
  status?: QuizAttemptStatus;
}

// ========================================
// 進捗トラッキング
// ========================================

export interface UserProgress {
  id: string;              // userId_lessonId
  userId: string;
  lessonId: string;
  courseId: string;
  videoCompleted: boolean;
  quizPassed: boolean;
  quizBestScore: number | null;
  lessonCompleted: boolean;
  updatedAt: string;
}

export interface CourseProgress {
  id: string;              // userId_courseId
  userId: string;
  courseId: string;
  completedLessons: number;
  totalLessons: number;
  progressRatio: number;   // 0-1
  isCompleted: boolean;
  updatedAt: string;
}

// ========================================
// 出席管理（レッスンセッション）
// ========================================

// TODO: "abandoned" はブラウザ終了検出（beforeunload/sendBeacon）で設定予定
export type LessonSessionStatus = "active" | "completed" | "force_exited" | "abandoned";
export type SessionExitReason = "quiz_submitted" | "pause_timeout" | "time_limit" | "browser_close";

export interface LessonSession {
  id: string;
  userId: string;
  lessonId: string;
  courseId: string;
  videoId: string;
  sessionToken: string;
  status: LessonSessionStatus;
  entryAt: string;                        // 入室打刻（動画再生開始時）
  exitAt: string | null;                  // 退室打刻（テスト送信 or 強制退室時）
  exitReason: SessionExitReason | null;
  deadlineAt: string;                     // entryAt + 2時間
  pauseStartedAt: string | null;        // TODO: video-eventsルート拡張で更新予定
  longestPauseSec: number;              // TODO: pause検知サーバーサイドで更新予定
  sessionVideoCompleted: boolean;       // TODO: video-eventsルートでセッション内完了判定時に更新予定
  quizAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LessonSessionFilter {
  userId?: string;
  lessonId?: string;
  courseId?: string;
  status?: LessonSessionStatus;
}
