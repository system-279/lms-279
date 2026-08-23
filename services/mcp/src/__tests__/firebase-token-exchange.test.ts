import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exchangeRefreshToken, TokenExchangeError } from "../firebase-token-exchange.js";

describe("exchangeRefreshToken", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("成功時は idToken/refreshToken/expiresIn を返す", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: "new-id-token",
          refresh_token: "rotated-refresh-token",
          expires_in: "3600",
        }),
        { status: 200 }
      )
    );

    const result = await exchangeRefreshToken("old-refresh-token", "api-key");

    expect(result).toEqual({
      idToken: "new-id-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3600,
    });
  });

  it("正しいエンドポイント・パラメータでリクエストする", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id_token: "x", refresh_token: "y", expires_in: "3600" }), { status: 200 })
    );

    await exchangeRefreshToken("my-refresh-token", "my-api-key");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://securetoken.googleapis.com/v1/token?key=my-api-key"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/x-www-form-urlencoded" }),
      })
    );
    const call = vi.mocked(global.fetch).mock.calls[0];
    const body = call?.[1]?.body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=my-refresh-token");
  });

  it("400 invalid_grant（リフレッシュトークン失効）は permanent エラーを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 400, message: "TOKEN_EXPIRED" } }), { status: 400 })
    );

    await expect(exchangeRefreshToken("expired-token", "api-key")).rejects.toMatchObject({
      transient: false,
    } satisfies Partial<TokenExchangeError>);
  });

  it("503（サービス一時不調）は transient エラーを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 503 }));

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: true,
    } satisfies Partial<TokenExchangeError>);
  });

  it("429（レート制限）は transient エラーを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 429 }));

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: true,
    } satisfies Partial<TokenExchangeError>);
  });

  it("ネットワークエラー（fetch自体の例外）は transient エラーを投げる", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new TypeError("fetch failed"));

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: true,
    } satisfies Partial<TokenExchangeError>);
  });
});
