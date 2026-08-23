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

  it("400 TOKEN_EXPIRED（リフレッシュトークン失効）は permanent かつ revoked:true のエラーを投げる（codex review指摘: 失効判定に使う）", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 400, message: "TOKEN_EXPIRED" } }), { status: 400 })
    );

    await expect(exchangeRefreshToken("expired-token", "api-key")).rejects.toMatchObject({
      transient: false,
      revoked: true,
    } satisfies Partial<TokenExchangeError>);
  });

  it.each(["USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN"])(
    "400 %s は revoked:true のエラーを投げる（公式ドキュメント記載のトークン失効系エラーコード）",
    async (code) => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: { message: code } }), { status: 400 })
      );

      await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
        transient: false,
        revoked: true,
      } satisfies Partial<TokenExchangeError>);
    }
  );

  it("400 API key not valid（設定不備。トークン失効とは無関係）は revoked:false の permanent エラーを投げる（codex review指摘: 誤って資格情報を削除しないため）", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), {
        status: 400,
      })
    );

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
      revoked: false,
    } satisfies Partial<TokenExchangeError>);
  });

  it("400 PROJECT_NUMBER_MISMATCH（設定不備）は revoked:false の permanent エラーを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "PROJECT_NUMBER_MISMATCH" } }), { status: 400 })
    );

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
      revoked: false,
    } satisfies Partial<TokenExchangeError>);
  });

  it("400だがエラー本文が空/パース不能の場合はrevoked:falseの permanent エラーを投げる（安全側=誤削除しない）", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 400 }));

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
      revoked: false,
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

  it("422（バリデーションエラー）は permanent エラーを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 422 }));

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
    } satisfies Partial<TokenExchangeError>);
  });

  it("500（サーバーエラー境界値）は transient エラーを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 500 }));

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: true,
    } satisfies Partial<TokenExchangeError>);
  });

  it("200応答だがJSONとしてパースできない場合はpermanentなTokenExchangeErrorを投げる（生のSyntaxErrorを漏らさない）", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("not json", { status: 200 }));

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toBeInstanceOf(TokenExchangeError);
    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
    } satisfies Partial<TokenExchangeError>);
  });

  it("200応答だがid_tokenが欠落している場合はpermanentなTokenExchangeErrorを投げる（undefinedを成功として返さない）", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ refresh_token: "y", expires_in: "3600" }), { status: 200 })
    );

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
    } satisfies Partial<TokenExchangeError>);
  });

  it("200応答だがrefresh_tokenが欠落している場合はpermanentなTokenExchangeErrorを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id_token: "x", expires_in: "3600" }), { status: 200 })
    );

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
    } satisfies Partial<TokenExchangeError>);
  });

  it("200応答だがexpires_inが数値化できない場合はpermanentなTokenExchangeErrorを投げる", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id_token: "x", refresh_token: "y", expires_in: "not-a-number" }), { status: 200 })
    );

    await expect(exchangeRefreshToken("token", "api-key")).rejects.toMatchObject({
      transient: false,
    } satisfies Partial<TokenExchangeError>);
  });
});
