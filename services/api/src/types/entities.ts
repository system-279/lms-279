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
