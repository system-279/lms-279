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

    it("tenant引数にパス区切り・クエリ文字を含む値を渡しても、単一のエンコード済みパスセグメントとして扱われエンドポイントを書き換えられない（codex review P2指摘: 未エンコードだと../や?でエンドポイントを操作できた）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ courses: [] }), { status: 200 }));

      const maliciousTenant = "../v2/super/master/quizzes/xyz?";
      await client.listCourses(maliciousTenant, "id-token-1");

      const calledUrl = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(calledUrl).toBe(
        `https://api.example.test/api/v2/${encodeURIComponent(maliciousTenant)}/admin/courses`
      );
      // 実際に送られたURLに、意図しないパス区切り("/")やクエリ開始("?")が
      // 生の状態で紛れ込んでいないことを直接確認する
      const pathAndQuery = calledUrl.replace("https://api.example.test/api/v2/", "");
      const tenantSegment = pathAndQuery.split("/admin/courses")[0]!;
      expect(tenantSegment).not.toContain("/");
      expect(tenantSegment).not.toContain("?");
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

    it("courseId引数にパス区切り・クエリ文字を含む値を渡しても、単一のエンコード済みパスセグメントとして扱われる（tenant同様の防御をcourseIdにも適用していることの確認）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ lessons: [] }), { status: 200 }));

      const maliciousCourseId = "../super/master/quizzes?";
      await client.listLessons("tenant-a", maliciousCourseId, "id-token-1");

      const calledUrl = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(calledUrl).toBe(
        `https://api.example.test/api/v2/tenant-a/admin/courses/${encodeURIComponent(maliciousCourseId)}/lessons`
      );
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

    it("lessonId引数にパス区切り・クエリ文字を含む値を渡しても、単一のエンコード済みパスセグメントとして扱われる（tenant/courseId同様の防御をlessonIdにも適用していることの確認）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ quiz: { id: "q1" } }), { status: 200 }));

      const maliciousLessonId = "../super/master/quizzes/xyz?";
      await client.getQuiz("tenant-a", maliciousLessonId, "id-token-1");

      const calledUrl = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(calledUrl).toBe(
        `https://api.example.test/api/v2/tenant-a/admin/lessons/${encodeURIComponent(maliciousLessonId)}/quiz`
      );
    });
  });

  describe("createQuiz", () => {
    const payload = { title: "New Quiz", questions: [{ id: "q1", text: "Q", type: "single" as const, options: [{ id: "o1", text: "A", isCorrect: true }], points: 10, explanation: "" }] };

    it("POSTでContent-Type: application/jsonヘッダ + JSON文字列化したボディを送り、201のquizを返す", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ quiz: { id: "q1", title: "New Quiz" } }), { status: 201 })
      );

      const result = await client.createQuiz("tenant-a", "lesson-1", payload, "id-token-1");

      expect(result).toEqual({ id: "q1", title: "New Quiz" });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.test/api/v2/tenant-a/admin/lessons/lesson-1/quiz",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer id-token-1", "Content-Type": "application/json" }),
          body: JSON.stringify(payload),
        })
      );
    });

    it("409(quiz_already_exists)はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "quiz_already_exists", message: "A quiz already exists for this lesson" }), {
          status: 409,
        })
      );

      await expect(client.createQuiz("tenant-a", "lesson-1", payload, "id-token-1")).rejects.toMatchObject({
        code: "quiz_already_exists",
        httpStatus: 409,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("400(invalid_title等)はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_title", message: "title is required" }), { status: 400 })
      );

      await expect(client.createQuiz("tenant-a", "lesson-1", payload, "id-token-1")).rejects.toMatchObject({
        code: "invalid_title",
        httpStatus: 400,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("応答のquizがnullの場合はエラーとして扱う（PATCHのレース条件バグ対策と同一パターン）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ quiz: null }), { status: 201 }));

      await expect(client.createQuiz("tenant-a", "lesson-1", payload, "id-token-1")).rejects.toMatchObject({
        transient: false,
      } satisfies Partial<LmsApiError>);
    });
  });

  describe("updateQuiz", () => {
    const payload = { title: "Updated Title" };

    it("PATCHでContent-Type: application/jsonヘッダ + JSON文字列化したボディを送り、200のquizを返す", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ quiz: { id: "q1", title: "Updated Title" } }), { status: 200 })
      );

      const result = await client.updateQuiz("tenant-a", "lesson-1", payload, "id-token-1");

      expect(result).toEqual({ id: "q1", title: "Updated Title" });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.test/api/v2/tenant-a/admin/lessons/lesson-1/quiz",
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({ Authorization: "Bearer id-token-1", "Content-Type": "application/json" }),
          body: JSON.stringify(payload),
        })
      );
    });

    it("404(quiz未設定)はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found", message: "Quiz not found for this lesson" }), {
          status: 404,
        })
      );

      await expect(client.updateQuiz("tenant-a", "lesson-1", payload, "id-token-1")).rejects.toMatchObject({
        httpStatus: 404,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("応答が200 {quiz:null}の場合はエラーとして扱う（レース条件でquizが削除された既存APIのバグへの対策、Codexセカンドオピニオンで発覚）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ quiz: null }), { status: 200 }));

      await expect(client.updateQuiz("tenant-a", "lesson-1", payload, "id-token-1")).rejects.toMatchObject({
        transient: false,
      } satisfies Partial<LmsApiError>);
    });
  });

  describe("deleteQuiz", () => {
    it("DELETEでリクエストし、204の空応答を成功として扱う", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(null, { status: 204 }));

      await expect(client.deleteQuiz("tenant-a", "lesson-1", "id-token-1")).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.test/api/v2/tenant-a/admin/lessons/lesson-1/quiz",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ Authorization: "Bearer id-token-1" }),
        })
      );
      // DELETEはボディを送らないため Content-Type ヘッダも付かない
      const callHeaders = vi.mocked(global.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(callHeaders["Content-Type"]).toBeUndefined();
    });

    it("404(quiz未設定)はpermanentなLmsApiErrorを投げる", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found", message: "Quiz not found for this lesson" }), {
          status: 404,
        })
      );

      await expect(client.deleteQuiz("tenant-a", "lesson-1", "id-token-1")).rejects.toMatchObject({
        httpStatus: 404,
        transient: false,
      } satisfies Partial<LmsApiError>);
    });
  });

  describe("空応答の許容範囲（204限定であることの回帰テスト）", () => {
    it("GETで異常な空200応答が来た場合、引き続きJSONパースエラーとして扱う（一般化しなかったことの確認）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(null, { status: 200 }));

      await expect(client.listCourses("tenant-a", "id-token-1")).rejects.toMatchObject({
        transient: false,
      } satisfies Partial<LmsApiError>);
    });

    it("POSTで異常な空200応答が来た場合、引き続きJSONパースエラーとして扱う（一般化しなかったことの確認）", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(null, { status: 200 }));
      const payload = { title: "x", questions: [] };

      await expect(client.createQuiz("tenant-a", "lesson-1", payload, "id-token-1")).rejects.toMatchObject({
        transient: false,
      } satisfies Partial<LmsApiError>);
    });
  });
});
