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

// ========================================
// 動画関連
// ========================================

export type VideoSourceType = "gcs" | "external_url";

export interface Video {
  id: string;
  lessonId: string;
  courseId: string;
  sourceType: VideoSourceType;
  sourceUrl?: string;       // sourceType=external_url時
  gcsPath?: string;         // sourceType=gcs時
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
