import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLmsApiClient, LmsApiError } from "../lms-api-client.js";

describe("createLmsApiClient", () => {
  const originalFetch = global.fetch;
  const client = createLmsApiClient("https://api.example.test");

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("listCourses", () => {
    it("正しいURL・Authorizationヘッダでリクエストし、courses配列を返す", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ courses: [{ id: "c1", name: "Course 1" }] }), { status: 200 })
      );

      const result = await client.listCourses("tenant-a", "id-token-1");

      expect(result).toEqual([{ id: "c1", name: "Course 1" }]);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.test/api/v2/tenant-a/admin/courses",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer id-token-1" }),
        })
      );
    });

    it("404はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found", message: "not found" }), { status: 404 })
      );

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        code: "not_found",
        httpStatus: 404,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("403はpermanentなLmsApiErrorを投げる（非admin）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
      );

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        code: "forbidden",
        httpStatus: 403,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("401はLmsApiErrorを投げる（呼び出し元でのリトライ判断用）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
      );

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        code: "unauthorized",
        httpStatus: 401,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("500はtransientなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 500 }));

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        httpStatus: 500,
        transient: true,
      } satisfies Partial<LmsApiError>);
    });

    it("ネットワークエラー（fetch自体の例外）はtransientなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockRejectedValue(new TypeError("fetch failed"));

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        transient: true,
      } satisfies Partial<LmsApiError>);
    });

    it("タイムアウト時はtransientなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockRejectedValue(new DOMException("The operation was aborted", "TimeoutError"));

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        transient: true,
      } satisfies Partial<LmsApiError>);
    });

    it("200応答だがJSONとしてパースできない場合はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response("not json", { status: 200 }));

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("200応答だがcoursesフィールドが配列でない場合はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ courses: "not-an-array" }), { status: 200 }));

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        transient: false,
      } satisfies Partial<LmsApiError>);
    });
  });

  describe("listLessons", () => {
    it("正しいURLでリクエストし、lessons配列を返す", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ lessons: [{ id: "l1", hasQuiz: true }] }), { status: 200 })
      );

      const result = await client.listLessons("tenant-a", "course-1", "id-token-1");

      expect(result).toEqual([{ id: "l1", hasQuiz: true }]);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.test/api/v2/tenant-a/admin/courses/course-1/lessons",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer id-token-1" }),
        })
      );
    });

    it("404（存在しないcourseId）はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
      );

      await expect(client.listLessons("tenant-a", "missing", "id-token-1")).rejects.toMatchObject({
        httpStatus: 404,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });
  });

  describe("getQuiz", () => {
    it("正しいURLでリクエストし、quizを返す（正解・解説含む）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            quiz: {
              id: "q1",
              lessonId: "l1",
              questions: [{ id: "qq1", options: [{ id: "o1", isCorrect: true }], explanation: "because" }],
            },
          }),
          { status: 200 }
        )
      );

      const result = await client.getQuiz("tenant-a", "l1", "id-token-1");

      expect(result).toEqual({
        id: "q1",
        lessonId: "l1",
        questions: [{ id: "qq1", options: [{ id: "o1", isCorrect: true }], explanation: "because" }],
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.test/api/v2/tenant-a/admin/lessons/l1/quiz",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer id-token-1" }),
        })
      );
    });

    it("404（テスト未設定のレッスン）はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found", message: "Quiz not found for this lesson" }), {
          status: 404,
        })
      );

      await expect(client.getQuiz("tenant-a", "l1", "id-token-1")).rejects.toMatchObject({
        code: "not_found",
        httpStatus: 404,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("200応答だがquizフィールドが欠落している場合はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await expect(client.getQuiz("tenant-a", "l1", "id-token-1")).rejects.toMatchObject({
        transient: false,
      } satisfies Partial<LmsApiError>);
    });
  });
});
