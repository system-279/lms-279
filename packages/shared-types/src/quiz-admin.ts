/**
 * MCPコネクタ管理者向けクイズ管理DTO
 * ソース: services/api の管理者向けエンドポイント（admin権限、tenant-auth.ts）
 *   - GET /admin/courses → AdminCourseSummary[]
 *   - GET /admin/courses/:courseId/lessons → AdminLessonSummary[]
 *   - GET /admin/lessons/:lessonId/quiz → AdminQuizResponse（正解・解説を含む全情報）
 */

export interface AdminCourseSummary {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  lessonOrder: string[];
  passThreshold: number;
  createdBy: string;
  sourceMasterCourseId?: string;
  copiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminLessonSummary {
  id: string;
  courseId: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
  videoUnlocksPrior: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminQuizOption {
  id: string;
  text: string;
  isCorrect: boolean;
}

export interface AdminQuizQuestion {
  id: string;
  text: string;
  type: "single" | "multi";
  options: AdminQuizOption[];
  points: number;
  explanation: string;
}

/**
 * 管理者向けなので正解(isCorrect)・解説(explanation)を含む全情報。
 * MCPツール get_quiz 経由でAnthropicのクラウド基盤を通過することを
 * 開発者確認済み（計画linear-zooming-conway.md「PR B」節参照）。
 */
export interface AdminQuizResponse {
  quiz: {
    id: string;
    lessonId: string;
    courseId: string;
    title: string;
    passThreshold: number;
    maxAttempts: number;
    timeLimitSec: number | null;
    randomizeQuestions: boolean;
    randomizeAnswers: boolean;
    requireVideoCompletion: boolean;
    questions: AdminQuizQuestion[];
    createdAt: string;
    updatedAt: string;
  };
}
