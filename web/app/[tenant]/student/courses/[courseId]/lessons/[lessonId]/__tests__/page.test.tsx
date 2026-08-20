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
import { ApiError } from "@/lib/api";

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

function lessonDetailResponse(
  overrides: Partial<{ pdfDownloadEligibility: string; quizSkipEnabled: boolean; sessionRequired: boolean }> = {},
) {
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
    // テスト任意化 Stage 5(ケースD厳格化): hasVideo=false のレッスンを使うテストのため false
    sessionRequired: overrides.sessionRequired ?? false,
  };
}

function quizByLessonResponse(
  overrides: Partial<{
    skipAvailable: boolean;
    quizSkipped: boolean;
    retakeBlocked: boolean;
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
  };
}

let quizByLessonOverrides: Parameters<typeof quizByLessonResponse>[0] = {};
// テスト任意化 Stage 5(ケースD厳格化): POST /quizzes/:quizId/attempts の失敗を
// テストごとに差し替えるためのフック（既定は成功、attempt作成を返す）。
let attemptsPostError: ApiError | null = null;

async function defaultAuthFetchImpl(url: string, options?: RequestInit) {
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
  if (url === `/api/v1/quizzes/${QUIZ_ID}/attempts` && method === "POST") {
    if (attemptsPostError) throw attemptsPostError;
    return { attempt: { id: "attempt-1", quizId: QUIZ_ID, startedAt: "2026-01-01T00:00:00.000Z", timeLimitSec: null } };
  }
  throw new Error(`unmocked authFetch call: ${method} ${url}`);
}

beforeEach(() => {
  quizByLessonOverrides = {};
  attemptsPostError = null;
  authFetchMock.mockReset();
  authFetchMock.mockImplementation(defaultAuthFetchImpl);
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

  it("テスト任意化 Stage 5(ケースD厳格化): POST /attempts が409 session_requiredで失敗した場合、案内文言が表示される", async () => {
    attemptsPostError = new ApiError(409, "session_required", "動画を再生してレッスンセッションを開始してから受験してください");
    render(<StudentLessonDetailPage />);

    const startButton = await screen.findByRole("button", { name: "テストを開始" });
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(screen.getByText("動画を再生してレッスンセッションを開始してから受験してください")).toBeInTheDocument();
    });
  });

  it("テスト任意化 Stage 5(ケースD厳格化): POST /attempts が409 quiz_already_passedで失敗した場合、再受験不可の状態へ遷移する", async () => {
    attemptsPostError = new ApiError(409, "quiz_already_passed", "既に合格しています");
    render(<StudentLessonDetailPage />);

    const startButton = await screen.findByRole("button", { name: "テストを開始" });
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(screen.getByText("既に合格しているため再受験できません")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "テストを開始" })).not.toBeInTheDocument();
  });
});

describe("StudentLessonDetailPage F1事前ゲート（ADR-027ケースG）", () => {
  const VIDEO_ID = "video-1";

  async function videoLessonAuthFetchImpl(url: string, options?: RequestInit) {
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
            hasVideo: true,
            hasQuiz: true,
            videoUnlocksPrior: false,
          },
        ],
        enrollmentSetting: null,
      };
    }
    if (url === `/api/v1/lessons/${LESSON_ID}`) {
      return lessonDetailResponse({ sessionRequired: false });
    }
    if (url === `/api/v1/lesson-sessions/active?lessonId=${LESSON_ID}`) {
      return {
        session: null,
        entryCooldown: {
          blocked: true,
          retryAfterMs: 42000,
          nextEntryAllowedAt: "2026-01-01T00:00:42.000Z",
          previousLessonId: "lesson-0",
        },
        entryGapMs: 60000,
      };
    }
    if (url === `/api/v1/lessons/${LESSON_ID}/video`) {
      return { video: { id: VIDEO_ID, speedLock: true } };
    }
    if (url === `/api/v1/videos/${VIDEO_ID}/playback-url`) {
      return { playbackUrl: "https://example.com/video.mp4" };
    }
    if (url === `/api/v1/quizzes/by-lesson/${LESSON_ID}`) {
      return quizByLessonResponse(quizByLessonOverrides);
    }
    throw new Error(`unmocked authFetch call: ${method} ${url}`);
  }

  beforeEach(() => {
    quizByLessonOverrides = {};
    authFetchMock.mockReset();
    authFetchMock.mockImplementation(videoLessonAuthFetchImpl);
  });

  it("entryCooldown.blocked=trueのとき、インライン通知が表示されVideoPlayerが無効化オーバーレイを描画する", async () => {
    render(<StudentLessonDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/あと42秒で開始できます/)).toBeInTheDocument();
    });

    expect(document.querySelector("[data-testid='video-player-disabled-overlay']")).not.toBeNull();
  });

  it("entryCooldown.blocked=trueのとき、動画クリックしてもセッション作成(POST /lesson-sessions)は呼ばれない", async () => {
    render(<StudentLessonDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/あと42秒で開始できます/)).toBeInTheDocument();
    });

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    if (video) fireEvent.click(video);

    const postCalls = authFetchMock.mock.calls.filter(
      ([url, opts]) => url === "/api/v1/lesson-sessions" && (opts as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("事前ゲートを通過した後にPOST /lesson-sessionsが409 entry_too_soonを返した場合（タイミング競合のフォールバック）、インライン通知と無効化オーバーレイに切り替わる", async () => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      if (url === `/api/v1/courses/${COURSE_ID}`) {
        return {
          course: { id: COURSE_ID, name: "コース1", description: "", status: "published", passThreshold: 70 },
          lessons: [
            {
              id: LESSON_ID, courseId: COURSE_ID, title: "レッスン1", order: 0,
              hasVideo: true, hasQuiz: true, videoUnlocksPrior: false,
            },
          ],
          enrollmentSetting: null,
        };
      }
      if (url === `/api/v1/lessons/${LESSON_ID}`) return lessonDetailResponse({ sessionRequired: false });
      // 事前ゲート段階では entryCooldown なし（ブロックされていない）
      if (url === `/api/v1/lesson-sessions/active?lessonId=${LESSON_ID}`) return { session: null };
      if (url === `/api/v1/lessons/${LESSON_ID}/video`) return { video: { id: VIDEO_ID, speedLock: true } };
      if (url === `/api/v1/videos/${VIDEO_ID}/playback-url`) return { playbackUrl: "https://example.com/video.mp4" };
      if (url === `/api/v1/quizzes/by-lesson/${LESSON_ID}`) return quizByLessonResponse(quizByLessonOverrides);
      if (url === "/api/v1/lesson-sessions" && method === "POST") {
        throw new ApiError(409, "entry_too_soon", "前のレッスンを退室してから少し間隔をあけてください", {
          retryAfterMs: 15000,
          nextEntryAllowedAt: "2026-01-01T00:00:15.000Z",
          previousLessonId: "lesson-0",
        });
      }
      throw new Error(`unmocked authFetch call: ${method} ${url}`);
    });

    render(<StudentLessonDetailPage />);

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });

    // 事前ゲートは通過している（disabledオーバーレイなし）
    expect(document.querySelector("[data-testid='video-player-disabled-overlay']")).toBeNull();

    fireEvent.play(video);

    await waitFor(() => {
      expect(screen.getByText(/あと15秒で開始できます/)).toBeInTheDocument();
    });
    expect(document.querySelector("[data-testid='video-player-disabled-overlay']")).not.toBeNull();
  });
});
