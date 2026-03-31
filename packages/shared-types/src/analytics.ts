/**
 * 分析API レスポンスDTO
 * ソース: services/api/src/routes/shared/analytics.ts の res.json() から抽出
 */

import type { SuspiciousFlag } from "./enums.js";

// ============================================================
// 1. コース別進捗分析
// GET /admin/analytics/courses/:courseId/progress
// ============================================================

export interface CourseProgressStudent {
  userId: string;
  userName: string | null;
  email: string;
  completedLessons: number;
  totalLessons: number;
  progressRatio: number;
  isCompleted: boolean;
}

export interface CourseProgressResponse {
  course: { id: string; name: string };
  totalStudents: number;
  completedStudents: number;
  avgProgressRatio: number;
  students: CourseProgressStudent[];
}

// ============================================================
// 2. ユーザー別進捗分析
// GET /admin/analytics/users/:userId/progress
// ============================================================

export interface UserLessonProgress {
  lessonId: string;
  lessonTitle: string | null;
  videoCompleted: boolean;
  quizPassed: boolean;
  lessonCompleted: boolean;
}

export interface UserCourseProgress {
  courseId: string;
  courseName: string | null;
  completedLessons: number;
  totalLessons: number;
  progressRatio: number;
  isCompleted: boolean;
  lessonProgresses: UserLessonProgress[];
}

export interface UserProgressResponse {
  user: { id: string; name: string | null; email: string };
  courses: UserCourseProgress[];
}

// ============================================================
// 3. 動画視聴統計
// GET /admin/analytics/videos/:videoId/stats
// ============================================================

export interface VideoStatsViewer {
  userId: string;
  userName: string | null;
  coverageRatio: number;
  isComplete: boolean;
  seekCount: number;
  speedViolationCount: number;
  suspiciousFlags: SuspiciousFlag[];
}

export interface VideoStatsResponse {
  video: { id: string; lessonId: string; durationSec: number };
  totalViewers: number;
  completedViewers: number;
  avgCoverageRatio: number;
  avgWatchTimeSec: number;
  viewers: VideoStatsViewer[];
}

// ============================================================
// 4. テスト統計
// GET /admin/analytics/quizzes/:quizId/stats
// ============================================================

export interface QuizStatsAttempt {
  userId: string;
  userName: string | null;
  attemptNumber: number;
  score: number | null;
  isPassed: boolean | null;
  submittedAt: string | null;
}

export interface QuizStatsResponse {
  quiz: { id: string; lessonId: string; title: string; passThreshold: number };
  totalAttempts: number;
  uniqueStudents: number;
  passRate: number;
  avgScore: number;
  attempts: QuizStatsAttempt[];
}

// ============================================================
// 5. 不審視聴一覧
// GET /admin/analytics/suspicious-viewing
// ============================================================

export interface SuspiciousViewingRecord {
  userId: string;
  userName: string | null;
  videoId: string;
  lessonTitle: string | null;
  coverageRatio: number;
  seekCount: number;
  speedViolationCount: number;
  suspiciousFlags: SuspiciousFlag[];
  updatedAt: string;
}

export interface SuspiciousViewingResponse {
  suspiciousViewings: SuspiciousViewingRecord[];
}
