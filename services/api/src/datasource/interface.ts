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
} from "../types/entities.js";

export type { CourseFilter, LessonFilter } from "../types/entities.js";

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
