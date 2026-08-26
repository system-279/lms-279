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

/**
 * type: "single" の場合、options中のisCorrect:trueがちょうど1つでなければならない。
 * この不変条件は型では表現されず、MCPコネクタ境界のzodスキーマ（services/mcp/src/
 * mcp-server.ts の quizQuestionSchema）でのみ検証される（API側 validateQuestions が
 * 正典、二重実装のドリフトリスクを認識した上での意図的な選択）。
 */
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

/**
 * MCPコネクタ管理者向けクイズ作成リクエストDTO（Phase 2b PR C2）。
 * ソース: POST /admin/lessons/:lessonId/quiz のリクエストボディ形状に一致。
 */
export interface AdminQuizCreateRequest {
  title: string;
  questions: AdminQuizQuestion[];
  passThreshold?: number;
  maxAttempts?: number;
  timeLimitSec?: number | null;
  randomizeQuestions?: boolean;
  randomizeAnswers?: boolean;
  requireVideoCompletion?: boolean;
}

/**
 * MCPコネクタ管理者向けクイズ更新リクエストDTO（Phase 2b PR C2）。
 * ソース: PATCH /admin/lessons/:lessonId/quiz のリクエストボディ形状に一致。全フィールド任意。
 *
 * 呼び出し規約: 全フィールドoptionalだが、最低1フィールドは値を持つこと。
 * 空更新（全フィールド省略）はAPI側 applyUpdate が updatedAt を無条件に書き換えるため、
 * 他クライアントの楽観的な差分検知（expectedUpdatedAt）を無意味に失効させる副作用がある。
 * この制約は型では強制されず、呼び出し元（services/mcp/src/mcp-server.ts の
 * updateQuizSchema）のzod .refine() でのみ強制される。
 */
export interface AdminQuizUpdateRequest {
  title?: string;
  questions?: AdminQuizQuestion[];
  passThreshold?: number;
  maxAttempts?: number;
  timeLimitSec?: number | null;
  randomizeQuestions?: boolean;
  randomizeAnswers?: boolean;
  requireVideoCompletion?: boolean;
}
