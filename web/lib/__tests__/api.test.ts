/**
 * apiFetch / ApiError のエラー正規化テスト。
 *
 * 2026-06-19 本番障害 (PR #577 後):
 *   - BE `errorHandler` (ADR-0025 nested) が `{ error: { code, message } }` を返す
 *   - 旧 apiFetch (ADR-010 flat 想定) は `body.error` を string と仮定して
 *     ApiError constructor に object を渡してしまい、Error.super で `[object Object]`
 *     化して画面表示。
 *   - 本テストは nested / flat / parse 不能 / 部分欠落 で `[object Object]` が二度と
 *     画面に出ないことを保証する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiFetch, ApiError } from "../api";

const ORIGINAL_FETCH = global.fetch;

function mockFetchResponse(status: number, body: unknown, isJson = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(isJson ? JSON.stringify(body) : String(body)),
    json: isJson
      ? vi.fn().mockResolvedValue(body)
      : vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
  } as unknown as Response);
}

describe("ApiError constructor — runtime defense", () => {
  it("string message を保持する", () => {
    const err = new ApiError(400, "bad_request", "リクエストが不正です");
    expect(err.message).toBe("リクエストが不正です");
  });

  it("message が undefined なら code を使用", () => {
    const err = new ApiError(404, "not_found");
    expect(err.message).toBe("not_found");
  });

  it("message が空文字なら code を使用", () => {
    const err = new ApiError(404, "not_found", "");
    expect(err.message).toBe("not_found");
  });

  it("code も空 / message も空なら HTTP fallback (5xx)", () => {
    const err = new ApiError(500, "", "");
    expect(err.message).toBe("サーバーエラー (HTTP 500)。再度お試しください。");
    expect(err.message).not.toContain("[object Object]");
  });

  // pr-test-analyzer M4: 4xx は「サーバーエラー」だと誤誘導 → 専用文言
  it("4xx で code/message 空ならクライアントエラー文言を使う", () => {
    const err = new ApiError(400, "", "");
    expect(err.message).toBe("リクエストエラー (HTTP 400)。");
    expect(err.message).not.toContain("サーバーエラー");
  });

  it("status=0 (fetch 自体失敗) は通信エラー文言を使う", () => {
    const err = new ApiError(0, "", "");
    expect(err.message).toBe("通信エラーが発生しました。再度お試しください。");
  });
});

describe("apiFetch — error body normalization", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = "http://test-api";
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("ADR-010 flat 形式 { error, message } を正しく ApiError に変換", async () => {
    mockFetchResponse(400, { error: "file_too_large", message: "ファイルサイズが上限を超えています" });
    await expect(apiFetch("/test", {})).rejects.toMatchObject({
      status: 400,
      code: "file_too_large",
      message: "ファイルサイズが上限を超えています",
    });
  });

  it("nested 形式 { error: { code, message } } を吸収する (本番障害再現)", async () => {
    mockFetchResponse(500, {
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    let captured: unknown;
    try {
      await apiFetch("/test", {});
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ApiError);
    const apiErr = captured as ApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.code).toBe("INTERNAL_ERROR");
    expect(apiErr.message).toBe("Internal server error");
    // 絶対に [object Object] が含まれないこと (本テストの核心)
    expect(apiErr.message).not.toContain("[object Object]");
  });

  it("response body が JSON parse 不能でも [object Object] を出さない", async () => {
    mockFetchResponse(500, "<html>500 Internal Server Error</html>", false);
    let captured: unknown;
    try {
      await apiFetch("/test", {});
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ApiError);
    const apiErr = captured as ApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.code).toBe("unknown_error");
    expect(apiErr.message).toBe("サーバーエラー (HTTP 500)。再度お試しください。");
    expect(apiErr.message).not.toContain("[object Object]");
  });

  it("nested で message のみ欠落しても fallback で 500 文言が入る", async () => {
    mockFetchResponse(500, { error: { code: "INTERNAL_ERROR" } });
    let captured: unknown;
    try {
      await apiFetch("/test", {});
    } catch (e) {
      captured = e;
    }
    const apiErr = captured as ApiError;
    expect(apiErr.code).toBe("INTERNAL_ERROR");
    expect(apiErr.message).toBe("サーバーエラー (HTTP 500)。再度お試しください。");
  });

  it("body が空オブジェクトでも [object Object] を出さない", async () => {
    mockFetchResponse(503, {});
    let captured: unknown;
    try {
      await apiFetch("/test", {});
    } catch (e) {
      captured = e;
    }
    const apiErr = captured as ApiError;
    expect(apiErr.code).toBe("unknown_error");
    expect(apiErr.message).toBe("サーバーエラー (HTTP 503)。再度お試しください。");
  });

  it("4xx で message 欠落時は code を message に使用 (情報量を保つ)", async () => {
    mockFetchResponse(404, { error: "not_found" });
    let captured: unknown;
    try {
      await apiFetch("/test", {});
    } catch (e) {
      captured = e;
    }
    const apiErr = captured as ApiError;
    expect(apiErr.code).toBe("not_found");
    expect(apiErr.message).toBe("not_found");
  });

  // code-reviewer H1: nested 形式の details も拾う
  it("nested 形式 { error: { code, message, details } } で details を保持する", async () => {
    mockFetchResponse(422, {
      error: {
        code: "validation_failed",
        message: "Invalid input",
        details: { field: "fileName" },
      },
    });
    let captured: unknown;
    try {
      await apiFetch("/test", {});
    } catch (e) {
      captured = e;
    }
    const apiErr = captured as ApiError;
    expect(apiErr.code).toBe("validation_failed");
    expect(apiErr.message).toBe("Invalid input");
    expect(apiErr.details).toEqual({ field: "fileName" });
  });

  it("details が record 形式なら保持、それ以外は undefined", async () => {
    mockFetchResponse(422, {
      error: "validation_failed",
      message: "Invalid input",
      details: { field: "fileName" },
    });
    let captured: unknown;
    try {
      await apiFetch("/test", {});
    } catch (e) {
      captured = e;
    }
    const apiErr = captured as ApiError;
    expect(apiErr.details).toEqual({ field: "fileName" });
  });
});
