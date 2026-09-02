import { describe, it, expect, vi } from "vitest";
import { postToChat } from "../chat-client.js";

const SECRET_NAME = "projects/lms-279/secrets/ops-chat-webhook-url/versions/latest";
const WEBHOOK_URL = "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t";

describe("postToChat", () => {
  it("正常系: secretを取得しwebhookへJSON POSTする", async () => {
    const getSecret = vi.fn().mockResolvedValue(WEBHOOK_URL);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await postToChat("hello", SECRET_NAME, { fetchImpl, getSecret });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(getSecret).toHaveBeenCalledWith(SECRET_NAME);
    expect(fetchImpl).toHaveBeenCalledWith(
      WEBHOOK_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json; charset=UTF-8" }),
      })
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ text: "hello" });
  });

  it("4000文字を超えるテキストはトランケートする", async () => {
    const getSecret = vi.fn().mockResolvedValue(WEBHOOK_URL);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const longText = "x".repeat(5000);

    await postToChat(longText, SECRET_NAME, { fetchImpl, getSecret });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect((body.text as string).length).toBeLessThanOrEqual(4000);
    expect(body.text).toContain("...(truncated)");
  });

  it("webhookが非2xxを返す場合はok:falseとstatusを返す", async () => {
    const getSecret = vi.fn().mockResolvedValue(WEBHOOK_URL);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const result = await postToChat("hello", SECRET_NAME, { fetchImpl, getSecret });

    expect(result).toEqual({ ok: false, status: 404 });
  });

  it("fetchが例外を投げた場合はok:falseを返す（statusなし）", async () => {
    const getSecret = vi.fn().mockResolvedValue(WEBHOOK_URL);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await postToChat("hello", SECRET_NAME, { fetchImpl, getSecret });

    expect(result).toEqual({ ok: false });
  });

  it("Secret Manager取得自体が失敗した場合もok:falseを返す（fetchは呼ばれない）", async () => {
    const getSecret = vi.fn().mockRejectedValue(new Error("secret not found"));
    const fetchImpl = vi.fn();

    const result = await postToChat("hello", SECRET_NAME, { fetchImpl, getSecret });

    expect(result).toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetchにタイムアウト用のAbortSignalを渡す（Chat側が無応答でハングし続けるのを防ぐ）", async () => {
    const getSecret = vi.fn().mockResolvedValue(WEBHOOK_URL);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await postToChat("hello", SECRET_NAME, { fetchImpl, getSecret });

    const options = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetchがタイムアウト(AbortError)した場合もok:falseを返す（transientとして扱われる）", async () => {
    const getSecret = vi.fn().mockResolvedValue(WEBHOOK_URL);
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));

    const result = await postToChat("hello", SECRET_NAME, { fetchImpl, getSecret });

    expect(result).toEqual({ ok: false });
  });
});
