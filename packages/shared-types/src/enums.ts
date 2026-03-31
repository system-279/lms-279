/**
 * FE-BE共有の列挙型・ユニオン型
 * ソース: services/api/src/types/entities.ts
 */

export type UserRole = "admin" | "teacher" | "student";
export type CourseStatus = "draft" | "published" | "archived";
export type QuizAttemptStatus = "in_progress" | "submitted" | "timed_out";
export type QuestionType = "single" | "multi";
export type LessonSessionStatus = "active" | "completed" | "force_exited" | "abandoned";
export type SessionExitReason =
  | "quiz_submitted"
  | "pause_timeout"
  | "time_limit"
  | "browser_close"
  | "max_attempts_failed";
export type SuspiciousFlag =
  | "excessive_seeks"
  | "no_pauses_long_session"
  | "background_playback"
  | "speed_violation"
  | "position_jump";
