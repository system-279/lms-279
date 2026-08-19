/**
 * StudentLessonDetailPage のフェッチ配線テスト（テスト任意化 Stage 4）。
 *
 * このページは動画プレイヤー・セッション管理等を含む大規模コンポーネントのため、
 * 全体を網羅するテストではなく、PR #601 で実際に発生した回帰
 * (`fetchLessonDetail` の初回マウント時二重フェッチ、コミット 6d60bc6 で修正)
 * を機械的に検知する最小限のテストに限定する。
 *
 * `useVideoCompletion` をモックして動画完了状態を直接制御することで、
 * VideoPlayer 本体（HTML5 video API 依存）や動画メタ取得のモックを回避する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import StudentLessonDetailPage from "../page";

const COURSE_ID = "course-1";
const LESSON_ID = "lesson-1";
const QUIZ_ID = "quiz-1";

const authFetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ tenant: "test-tenant", courseId: COURSE_ID, lessonId: LESSON_ID }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/tenant-context", () => ({
  useTenant: () => ({ tenantId: "test-tenant" }),
}));

vi.mock("@/lib/hooks/use-authenticated-fetch", () => ({
  useAuthenticatedFetch: () => ({ authFetch: authFetchMock, authLoading: false }),
}));

// showQuizSection を直接制御し、動画視聴フロー(VideoPlayer本体)を経由せずに
// QuizSection をマウントさせる。hasVideo=false のレッスンを使うため video 系
// authFetch (video meta / playback-url) は本来呼ばれない。
vi.mock("@/lib/hooks/use-video-completion", () => ({
  useVideoCompletion: () => ({
    analytics: null,
    videoCompleted: false,
    loadingAnalytics: false,
    showQuizSection: true,
    fetchAnalytics: vi.fn(),
    handleVideoComplete: vi.fn(),
    setAnalyticsFromFlush: vi.fn(),
  }),
}));

function lessonDetailResponse(overrides: Partial<{ pdfDownloadEligibility: string; quizSkipEnabled: boolean }> = {}) {
  return {
    lesson: {
      id: LESSON_ID,
      courseId: COURSE_ID,
      title: "レッスン1",
      order: 0,
      hasVideo: false,
      hasQuiz: true,
      videoUnlocksPrior: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    resource: undefined,
    quizSkipEnabled: overrides.quizSkipEnabled ?? true,
    pdfDownloadEligibility: overrides.pdfDownloadEligibility ?? "needs_quiz_pass",
  };
}

function quizByLessonResponse(
  overrides: Partial<{
    skipAvailable: boolean;
    quizSkipped: boolean;
    retakeBlocked: boolean;
    sessionRequired: boolean;
  }> = {},
) {
  return {
    quiz: {
      id: QUIZ_ID,
      title: "テスト1",
      passThreshold: 70,
      maxAttempts: 3,
      timeLimitSec: null,
      questions: [],
    },
    userAttemptCount: 0,
    attemptSummaries: [],
    accessExpired: false,
    skipAvailable: overrides.skipAvailable ?? true,
    quizSkipped: overrides.quizSkipped ?? false,
    pdfDownloadAllowedForSkipped: true,
    // テスト任意化 Stage 5(ケースD厳格化): hasVideo=false のレッスンを使うテストのため免除される
    retakeBlocked: overrides.retakeBlocked ?? false,
    sessionRequired: overrides.sessionRequired ?? false,
  };
}

let quizByLessonOverrides: Parameters<typeof quizByLessonResponse>[0] = {};

beforeEach(() => {
  quizByLessonOverrides = {};
  authFetchMock.mockReset();
  authFetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";

    if (url === `/api/v1/courses/${COURSE_ID}`) {
      return {
        course: { id: COURSE_ID, name: "コース1", description: "", status: "published", passThreshold: 70 },
        lessons: [
          {
            id: LESSON_ID,
            courseId: COURSE_ID,
            title: "レッスン1",
            order: 0,
            hasVideo: false,
            hasQuiz: true,
            videoUnlocksPrior: false,
          },
        ],
        enrollmentSetting: null,
      };
    }
    if (url === `/api/v1/lessons/${LESSON_ID}`) {
      return lessonDetailResponse();
    }
    if (url.startsWith("/api/v1/lesson-sessions/active")) {
      return { session: null };
    }
    if (url === `/api/v1/quizzes/by-lesson/${LESSON_ID}`) {
      return quizByLessonResponse(quizByLessonOverrides);
    }
    if (url === `/api/v1/quizzes/${QUIZ_ID}/skip` && method === "POST") {
      return { quizSkipped: true, lessonCompleted: true, sessionRecorded: false };
    }
    throw new Error(`unmocked authFetch call: ${method} ${url}`);
  });
});

describe("StudentLessonDetailPage フェッチ配線", () => {
  it("初回マウントで GET /lessons/:lessonId が1回だけ呼ばれる（二重フェッチ回帰防止、PR #601 コミット6d60bc6）", async () => {
    render(<StudentLessonDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "レッスン1" })).toBeInTheDocument();
    });
    // QuizSection 自体のロードも待つ（fetchQuiz 完了後に onQuizStatusChanged は
    // もう呼ばれない設計だが、念のため描画完了まで待ってから件数を確定する）
    await waitFor(() => {
      expect(
        authFetchMock.mock.calls.filter(([url]) => url === `/api/v1/quizzes/by-lesson/${LESSON_ID}`),
      ).toHaveLength(1);
    });

    const lessonDetailCalls = authFetchMock.mock.calls.filter(
      ([url]) => url === `/api/v1/lessons/${LESSON_ID}`,
    );
    expect(lessonDetailCalls).toHaveLength(1);
  });

  it("テストスキップ成功後に GET /lessons/:lessonId が再取得される（onQuizStatusChanged配線）", async () => {
    render(<StudentLessonDetailPage />);

    const skipButton = await screen.findByRole("button", { name: "テストをスキップする" });
    fireEvent.click(skipButton);

    const confirmButton = await screen.findByRole("button", { name: "スキップする" });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const lessonDetailCalls = authFetchMock.mock.calls.filter(
        ([url]) => url === `/api/v1/lessons/${LESSON_ID}`,
      );
      // 初回マウント分(1) + スキップ後の再取得分(1) = 2
      expect(lessonDetailCalls).toHaveLength(2);
    });
  });

  it("テスト任意化 Stage 5(ケースD厳格化): retakeBlocked=trueのとき「テストを開始」ボタンが描画されず、再受験不可の文言が表示される", async () => {
    quizByLessonOverrides = { retakeBlocked: true };
    render(<StudentLessonDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("既に合格しているため再受験はできません。")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "テストを開始" })).not.toBeInTheDocument();
  });
});
