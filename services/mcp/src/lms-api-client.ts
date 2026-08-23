/**
 * services/api の管理者向けエンドポイントを呼び出すクライアント。
 * MCP quizツール（Phase 2a）専用。エラー分類は rules/error-handling.md §3準拠:
 * transient = ネットワーク/timeout/5xx、permanent = 4xx（401含む。リトライ判断は
 * 呼び出し元 mcp-server.ts が LmsApiError.httpStatus を見て行う）。
 *
 * 戻り値の型は @lms-279/shared-types の管理者向けDTOで表現する
 * （CLAUDE.md「新規APIエンドポイント追加時はshared-typesに型を先に定義すること」、
 * code-reviewerセカンドオピニオン指摘: 当初DTOを定義したのみで実際には
 * unknown型のまま配線されておらず型安全性が機能していなかった）。
 */
import type { AdminCourseSummary, AdminLessonSummary, AdminQuizResponse } from "@lms-279/shared-types";

export class LmsApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly httpStatus: number | undefined,
    readonly transient: boolean
  ) {
    super(message);
  }
}

export interface LmsApiClient {
  listCourses(tenant: string, idToken: string): Promise<AdminCourseSummary[]>;
  listLessons(tenant: string, courseId: string, idToken: string): Promise<AdminLessonSummary[]>;
  getQuiz(tenant: string, lessonId: string, idToken: string): Promise<AdminQuizResponse["quiz"]>;
}

function isTransientStatus(status: number): boolean {
  return status >= 500;
}

async function extractErrorBody(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    return {
      code: typeof body.error === "string" ? body.error : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
    };
  } catch {
    return {};
  }
}

async function requestJson(baseUrl: string, path: string, idToken: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new LmsApiError(`LMS APIへのリクエストに失敗しました: ${String(error)}`, undefined, undefined, true);
  }

  if (!response.ok) {
    const { code, message } = await extractErrorBody(response);
    throw new LmsApiError(
      message ?? `LMS APIがエラーを返しました (status=${response.status}${code ? `, code=${code}` : ""})`,
      code,
      response.status,
      isTransientStatus(response.status)
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new LmsApiError(`LMS APIの応答がJSONとして解釈できません: ${String(error)}`, undefined, response.status, false);
  }
}

export function createLmsApiClient(baseUrl: string): LmsApiClient {
  return {
    async listCourses(tenant, idToken) {
      const body = await requestJson(baseUrl, `/api/v2/${encodeURIComponent(tenant)}/admin/courses`, idToken);
      const courses = (body as { courses?: unknown })?.courses;
      if (!Array.isArray(courses)) {
        throw new LmsApiError("LMS APIの応答にcourses配列が含まれていません", undefined, undefined, false);
      }
      return courses as AdminCourseSummary[];
    },

    async listLessons(tenant, courseId, idToken) {
      const body = await requestJson(
        baseUrl,
        `/api/v2/${encodeURIComponent(tenant)}/admin/courses/${encodeURIComponent(courseId)}/lessons`,
        idToken
      );
      const lessons = (body as { lessons?: unknown })?.lessons;
      if (!Array.isArray(lessons)) {
        throw new LmsApiError("LMS APIの応答にlessons配列が含まれていません", undefined, undefined, false);
      }
      return lessons as AdminLessonSummary[];
    },

    async getQuiz(tenant, lessonId, idToken) {
      const body = await requestJson(
        baseUrl,
        `/api/v2/${encodeURIComponent(tenant)}/admin/lessons/${encodeURIComponent(lessonId)}/quiz`,
        idToken
      );
      const quiz = (body as { quiz?: unknown })?.quiz;
      if (typeof quiz !== "object" || quiz === null) {
        throw new LmsApiError("LMS APIの応答にquizが含まれていません", undefined, undefined, false);
      }
      return quiz as AdminQuizResponse["quiz"];
    },
  };
}
