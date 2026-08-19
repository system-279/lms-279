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
  /** テスト任意化(テナント単位スキップ)。動画未完了/既に合格済み/受験中/ポリシーOFFのいずれかでfalse */
  skipAvailable: boolean;
  /** 受講者が既にテストをスキップ済みか */
  quizSkipped: boolean;
  /** テナントがスキップ者への資料PDFダウンロードを許可しているか。Stage 3のUIでは文言に使わない(Stage 4で確定表示に使用予定) */
  pdfDownloadAllowedForSkipped: boolean;
}

// ============================================================
// POST /quizzes/:quizId/skip
// ============================================================

export interface QuizSkipResponse {
  quizSkipped: true;
  lessonCompleted: boolean;
  sessionRecorded: boolean;
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
