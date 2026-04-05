/**
 * DataSource インターフェース
 * Firestore と InMemory の両方で実装される抽象化レイヤー
 */

import type {
  Course,
  CourseFilter,
  Lesson,
  LessonFilter,
  User,
  NotificationPolicy,
  AllowedEmail,
  UserSettings,
  AuthErrorLog,
  Video,
  VideoEvent,
  VideoAnalytics,
  VideoFilter,
  VideoEventFilter,
  Quiz,
  QuizAttempt,
  QuizFilter,
  QuizAttemptFilter,
  UserProgress,
  CourseProgress,
  LessonSession,
  TenantEnrollmentSetting,
} from "../types/entities.js";

export type { CourseFilter, LessonFilter, Video, VideoEvent, VideoAnalytics, VideoFilter, VideoEventFilter, WatchedRange, SuspiciousFlag } from "../types/entities.js";
export type { Quiz, QuizAttempt, QuizFilter, QuizAttemptFilter, QuizQuestion, QuizOption, QuestionType, QuizAttemptStatus } from "../types/entities.js";
export type { UserProgress, CourseProgress } from "../types/entities.js";
export type { LessonSession, LessonSessionFilter, LessonSessionStatus, SessionExitReason } from "../types/entities.js";
export type { TenantEnrollmentSetting } from "../types/entities.js";

export interface NotificationPolicyFilter {
  scope?: "global" | "course" | "user";
  courseId?: string;
  userId?: string;
  active?: boolean;
}

export interface AuthErrorLogFilter {
  email?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

/**
 * 更新用の型定義
 * イミュータブルフィールド（id, createdAt, updatedAt）を除外
 */
export type CourseUpdateData = Partial<Omit<Course, "id" | "createdAt" | "updatedAt">>;
export type LessonUpdateData = Partial<Omit<Lesson, "id" | "createdAt" | "updatedAt">>;
export type UserUpdateData = Partial<Omit<User, "id" | "createdAt" | "updatedAt">>;
export type NotificationPolicyUpdateData = Partial<Omit<NotificationPolicy, "id" | "createdAt" | "updatedAt">>;

/**
 * テナントコンテキスト
 */
export interface TenantContext {
  tenantId: string;
  isDemo: boolean;
}

/**
 * DataSource インターフェース
 * テナント単位でインスタンス化される
 */
export interface DataSource {
  // Courses
  getCourses(filter?: CourseFilter): Promise<Course[]>;
  getCourseById(id: string): Promise<Course | null>;
  createCourse(data: Omit<Course, "id" | "createdAt" | "updatedAt">): Promise<Course>;
  updateCourse(id: string, data: CourseUpdateData): Promise<Course | null>;
  deleteCourse(id: string): Promise<boolean>;

  // Lessons
  getLessons(filter?: LessonFilter): Promise<Lesson[]>;
  getLessonById(id: string): Promise<Lesson | null>;
  createLesson(data: Omit<Lesson, "id" | "createdAt" | "updatedAt">): Promise<Lesson>;
  updateLesson(id: string, data: LessonUpdateData): Promise<Lesson | null>;
  deleteLesson(id: string): Promise<boolean>;
  reorderLessons(courseId: string, lessonIds: string[]): Promise<void>;

  // Users
  getUsers(): Promise<User[]>;
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByFirebaseUid(uid: string): Promise<User | null>;
  createUser(data: Omit<User, "id" | "createdAt" | "updatedAt">): Promise<User>;
  updateUser(id: string, data: UserUpdateData): Promise<User | null>;
  deleteUser(id: string): Promise<boolean>;

  // Allowed Emails
  getAllowedEmails(): Promise<AllowedEmail[]>;
  getAllowedEmailById(id: string): Promise<AllowedEmail | null>;
  isEmailAllowed(email: string): Promise<boolean>;
  createAllowedEmail(data: Omit<AllowedEmail, "id" | "createdAt">): Promise<AllowedEmail>;
  deleteAllowedEmail(id: string): Promise<boolean>;
  deleteAllowedEmailByEmail(email: string): Promise<boolean>;

  // Notification Policies
  getNotificationPolicies(filter?: NotificationPolicyFilter): Promise<NotificationPolicy[]>;
  getNotificationPolicyById(id: string): Promise<NotificationPolicy | null>;
  createNotificationPolicy(data: Omit<NotificationPolicy, "id" | "createdAt" | "updatedAt">): Promise<NotificationPolicy>;
  updateNotificationPolicy(id: string, data: NotificationPolicyUpdateData): Promise<NotificationPolicy | null>;
  deleteNotificationPolicy(id: string): Promise<boolean>;

  // Auth Error Logs
  /**
   * 認証エラーログ一覧を取得
   * @param filter フィルタ条件
   * @returns 認証エラーログの配列
   */
  getAuthErrorLogs(filter?: AuthErrorLogFilter): Promise<AuthErrorLog[]>;

  /**
   * 認証エラーログを作成
   * @param data 認証エラーログデータ
   * @returns 作成された認証エラーログ
   */
  createAuthErrorLog(data: Omit<AuthErrorLog, "id">): Promise<AuthErrorLog>;

  // User Settings
  getUserSettings(userId: string): Promise<UserSettings | null>;
  upsertUserSettings(userId: string, data: Partial<UserSettings>): Promise<UserSettings>;

  // Videos
  getVideos(filter?: VideoFilter): Promise<Video[]>;
  getVideoById(id: string): Promise<Video | null>;
  getVideoByLessonId(lessonId: string): Promise<Video | null>;
  createVideo(data: Omit<Video, "id" | "createdAt" | "updatedAt">): Promise<Video>;
  updateVideo(id: string, data: Partial<Pick<Video, "sourceType" | "sourceUrl" | "gcsPath" | "durationSec" | "requiredWatchRatio" | "speedLock" | "driveFileId" | "importStatus" | "importError">>): Promise<Video | null>;
  deleteVideo(id: string): Promise<boolean>;

  // Video Events
  createVideoEvents(events: Omit<VideoEvent, "id" | "timestamp">[]): Promise<VideoEvent[]>;
  getVideoEvents(filter: VideoEventFilter): Promise<VideoEvent[]>;

  // Video Analytics
  getVideoAnalytics(userId: string, videoId: string): Promise<VideoAnalytics | null>;
  getVideoAnalyticsByVideoId(videoId: string): Promise<VideoAnalytics[]>;
  getAllVideoAnalytics(): Promise<VideoAnalytics[]>;
  upsertVideoAnalytics(userId: string, videoId: string, data: Partial<Omit<VideoAnalytics, "id" | "videoId" | "userId">>): Promise<VideoAnalytics>;
  /**
   * アトミックにVideoAnalyticsを読み取り→計算→書き込み。
   * 並行リクエストによるロストアップデートを防止する。
   * compute関数は現在の値を受け取り、更新データを返す。
   */
  computeAndUpsertVideoAnalytics(
    userId: string, videoId: string,
    compute: (current: VideoAnalytics | null) => Partial<Omit<VideoAnalytics, "id" | "videoId" | "userId">>
  ): Promise<VideoAnalytics>;

  // Quizzes
  getQuizzes(filter?: QuizFilter): Promise<Quiz[]>;
  getQuizById(id: string): Promise<Quiz | null>;
  getQuizByLessonId(lessonId: string): Promise<Quiz | null>;
  createQuiz(data: Omit<Quiz, "id" | "createdAt" | "updatedAt">): Promise<Quiz>;
  updateQuiz(id: string, data: Partial<Omit<Quiz, "id" | "createdAt" | "updatedAt">>): Promise<Quiz | null>;
  deleteQuiz(id: string): Promise<boolean>;

  // Quiz Attempts
  getQuizAttempts(filter: QuizAttemptFilter): Promise<QuizAttempt[]>;
  getQuizAttemptById(id: string): Promise<QuizAttempt | null>;
  createQuizAttempt(data: Omit<QuizAttempt, "id">): Promise<QuizAttempt>;
  /**
   * quiz attempt作成をトランザクションで保護（原子的操作）
   * - in_progress attemptが既に存在する場合は作成しない（既存attemptを返す）
   * - maxAttemptsを超える場合はnullを返す
   * - attemptNumberをトランザクション内で正確に採番
   */
  createQuizAttemptAtomic(
    quizId: string, userId: string, maxAttempts: number, timeLimitSec: number | null,
    data: Omit<QuizAttempt, "id" | "attemptNumber">
  ): Promise<{ attempt: QuizAttempt; existing: boolean } | null>;
  updateQuizAttempt(id: string, data: Partial<Omit<QuizAttempt, "id">>): Promise<QuizAttempt | null>;

  // User Progress
  getUserProgress(userId: string, lessonId: string): Promise<UserProgress | null>;
  getUserProgressByCourse(userId: string, courseId: string): Promise<UserProgress[]>;
  upsertUserProgress(userId: string, lessonId: string, data: Partial<Omit<UserProgress, "id" | "userId" | "lessonId">>): Promise<UserProgress>;

  // Course Progress
  getCourseProgress(userId: string, courseId: string): Promise<CourseProgress | null>;
  upsertCourseProgress(userId: string, courseId: string, data: Partial<Omit<CourseProgress, "id" | "userId" | "courseId">>): Promise<CourseProgress>;
  getCourseProgressByUser(userId: string): Promise<CourseProgress[]>;
  getCourseProgressByCourseId(courseId: string): Promise<CourseProgress[]>;

  // Lesson Sessions (Attendance)
  createLessonSession(data: Omit<LessonSession, "id" | "createdAt" | "updatedAt">): Promise<LessonSession>;
  /**
   * アクティブセッション取得または作成（アトミック操作）
   * 同一userId+lessonIdに対する並行呼び出しで重複activeセッションが作成されないことを保証する。
   * トランザクション失敗時はエラーをスローする。
   */
  getOrCreateLessonSession(
    userId: string, lessonId: string,
    data: Omit<LessonSession, "id" | "createdAt" | "updatedAt">
  ): Promise<{ session: LessonSession; created: boolean }>;
  getLessonSession(sessionId: string): Promise<LessonSession | null>;
  getActiveLessonSession(userId: string, lessonId: string): Promise<LessonSession | null>;
  updateLessonSession(sessionId: string, data: Partial<Omit<LessonSession, "id" | "createdAt">>): Promise<LessonSession | null>;
  getLessonSessionsByCourse(courseId: string): Promise<LessonSession[]>;

  // Lesson Data Reset (force exit)
  resetLessonDataForUser(userId: string, lessonId: string, courseId: string): Promise<void>;

  // Tenant Enrollment Setting (テナント単位の受講期間管理)
  getTenantEnrollmentSetting(): Promise<TenantEnrollmentSetting | null>;
  upsertTenantEnrollmentSetting(data: Omit<TenantEnrollmentSetting, "id" | "updatedAt">): Promise<TenantEnrollmentSetting>;
  deleteTenantEnrollmentSetting(): Promise<void>;
}

/**
 * 読み取り専用DataSource（デモモード用）
 * 書き込み操作は例外をスロー
 */
export class ReadOnlyDataSourceError extends Error {
  constructor() {
    super("This data source is read-only");
    this.name = "ReadOnlyDataSourceError";
  }
}
