/**
 * テスト関連 レスポンスDTO
 * ソース: services/api/src/routes/shared/quiz-attempts.ts
 */

// ============================================================
// GET /quizzes/by-lesson/:lessonId
// ============================================================

export interface QuizByLessonResponse {
  quiz: QuizByLessonQuiz;
  userAttemptCount: number;
  attemptSummaries: QuizAttemptSummary[];
  accessExpired: boolean;
  expiredReason?: string;
}

export interface QuizByLessonQuiz {
  id: string;
  title: string;
  passThreshold: number;
  maxAttempts: number;
  timeLimitSec: number | null;
  questions: QuizQuestionStripped[];
}

export interface QuizQuestionStripped {
  id: string;
  text: string;
  type: "single" | "multi";
  options: QuizOptionStripped[];
  points: number;
}

export interface QuizOptionStripped {
  id: string;
  text: string;
  isCorrect: boolean;
}

export interface QuizAttemptSummary {
  id: string;
  attemptNumber: number;
  status: "submitted" | "timed_out" | "in_progress";
  score: number | null;
  isPassed: boolean | null;
  startedAt: string;
  submittedAt: string | null;
}
