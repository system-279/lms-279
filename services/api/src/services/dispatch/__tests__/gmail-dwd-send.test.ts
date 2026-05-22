/**
 * gmail-dwd-send の単体テスト。
 *
 * 設計仕様書 §3.1 / FR-5 改訂 / NFR-9 / AC-3 / AC-32 / Phase 3 完了条件:
 *   - DWD JWT 生成 (gmail-client.ts 経由、subject=実 mailbox、scope=gmail.send)
 *   - MIME 組立 (添付なし、From=SendAs エイリアス、To=受講者本人、Cc=配列)
 *   - 429 / 503 / transient ネットワークエラーで exponential backoff retry 最大 3 回
 *   - 401 / 4xx / その他は即時 throw (caller 分類)
 *   - CC 配列空のとき Cc: ヘッダを省略
 *
 * 観点:
 *   - MIME 構造: From / To / Cc / Subject ヘッダ、base64 body、base64url 全体
 *   - Cc 空配列 → Cc: ヘッダ省略 (Phase 3 完了条件)
 *   - Cc 複数件 → カンマ + 半角空白で連結
 *   - 件名の日本語 → =?UTF-8?B?...?= encode
 *   - 件名 ASCII のみ → encode しない
 *   - CR/LF 注入 reject: From / To / Subject / Cc[]
 *   - 1 回目で成功 → attempts=1、messageId 返却
 *   - 429 1 回 → 2 回目成功 → attempts=2
 *   - 429 3 回連続 → throw (caller 側分類)
 *   - 503 retry, ECONNRESET retry
 *   - 401 / 400 / 403 → 即時 throw (no retry)
 *   - response.data.id が空 → throw
 *   - retry sleep の backoff が exponential (500 → 1000)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const jwtConstructorMock = vi.hoisted(() => vi.fn());
const gmailSendMock = vi.hoisted(() => vi.fn());
const accessSecretVersionMock = vi.hoisted(() => vi.fn());

vi.mock("googleapis", () => {
  class MockJWT {
    constructor(opts: Record<string, unknown>) {
      jwtConstructorMock(opts);
    }
  }
  return {
    google: {
      auth: { JWT: MockJWT },
      gmail: vi.fn(() => ({
        users: {
          messages: {
            send: gmailSendMock,
          },
        },
      })),
    },
  };
});

vi.mock("@google-cloud/secret-manager", () => {
  class MockSecretManagerServiceClient {
    accessSecretVersion = accessSecretVersionMock;
  }
  return { SecretManagerServiceClient: MockSecretManagerServiceClient };
});

// 動的 import (gmail-client.test.ts と同じ hoisted pattern)
const {
  buildCompletionMime,
  encodeMimeHeader,
  isTransientGmailError,
  sendCompletionMail,
  TRANSIENT_NETWORK_CODES,
} = await import("../gmail-dwd-send.js");
const { __resetCacheForTest } = await import("../gmail-client.js");

const FAKE_KEY = {
  client_email: "dwd-sa@lms-279.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
};

function setSecretManagerOk() {
  accessSecretVersionMock.mockResolvedValue([
    { payload: { data: JSON.stringify(FAKE_KEY) } },
  ]);
}

beforeEach(() => {
  __resetCacheForTest();
  jwtConstructorMock.mockClear();
  gmailSendMock.mockReset();
  accessSecretVersionMock.mockReset();
});

/** base64url decode helper */
function base64UrlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8");
}

describe("encodeMimeHeader (RFC 2047)", () => {
  it("ASCII のみはそのまま返す", () => {
    expect(encodeMimeHeader("Hello World")).toBe("Hello World");
  });

  it("日本語を =?UTF-8?B?...?= で encode", () => {
    const encoded = encodeMimeHeader("テスト");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const base64 = encoded.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
    expect(Buffer.from(base64, "base64").toString("utf-8")).toBe("テスト");
  });
});

describe("isTransientGmailError", () => {
  it("HTTP 429 → transient", () => {
    expect(isTransientGmailError({ response: { status: 429 } })).toBe(true);
  });
  it("HTTP 503 → transient", () => {
    expect(isTransientGmailError({ response: { status: 503 } })).toBe(true);
  });
  it("HTTP 500 → not transient (caller permanent 分類予定)", () => {
    expect(isTransientGmailError({ response: { status: 500 } })).toBe(false);
  });
  it("HTTP 401 → not transient", () => {
    expect(isTransientGmailError({ response: { status: 401 } })).toBe(false);
  });
  it("HTTP 403 → not transient (caller scope_revoked 分類)", () => {
    expect(isTransientGmailError({ response: { status: 403 } })).toBe(false);
  });
  it("ECONNRESET → transient (transport)", () => {
    expect(isTransientGmailError({ code: "ECONNRESET" })).toBe(true);
  });
  it("UND_ERR_SOCKET (cause) → transient", () => {
    expect(isTransientGmailError({ cause: { code: "UND_ERR_SOCKET" } })).toBe(true);
  });
  it("UNKNOWN_CODE → not transient", () => {
    expect(isTransientGmailError({ code: "UNKNOWN_CODE" })).toBe(false);
  });
  it("非 object (null, string) → not transient", () => {
    expect(isTransientGmailError(null)).toBe(false);
    expect(isTransientGmailError("ECONNRESET")).toBe(false);
  });
  it("TRANSIENT_NETWORK_CODES に主要 transport code が含まれる", () => {
    expect(TRANSIENT_NETWORK_CODES.has("ECONNRESET")).toBe(true);
    expect(TRANSIENT_NETWORK_CODES.has("ETIMEDOUT")).toBe(true);
    expect(TRANSIENT_NETWORK_CODES.has("UND_ERR_CONNECT_TIMEOUT")).toBe(true);
  });
});

describe("buildCompletionMime", () => {
  describe("MIME 構造", () => {
    it("From / To / Subject / MIME-Version / Content-Type / base64 body を含む", () => {
      const raw = buildCompletionMime({
        fromEmail: "dxcollege@279279.net",
        to: "student@example.com",
        cc: [],
        subject: "テスト件名",
        body: "本文テスト",
      });
      const decoded = base64UrlDecode(raw);
      expect(decoded).toContain("From: dxcollege@279279.net");
      expect(decoded).toContain("To: student@example.com");
      expect(decoded).toContain("MIME-Version: 1.0");
      expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8");
      expect(decoded).toContain("Content-Transfer-Encoding: base64");
      // 件名は RFC 2047 encode
      expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
      // 本文は base64 化される
      expect(decoded).toContain(Buffer.from("本文テスト", "utf-8").toString("base64"));
    });

    it("全行区切りが CRLF (LF 単独なし、evaluator narrative 反映で証明力強化)", () => {
      const raw = buildCompletionMime({
        fromEmail: "from@x.com",
        to: "to@x.com",
        cc: [],
        subject: "s",
        body: "b",
      });
      const decoded = base64UrlDecode(raw);
      // 全 CRLF を取り除いた残り文字列に LF が残らないことで「LF 単独なし」を保証
      const stripped = decoded.replace(/\r\n/g, "");
      expect(stripped).not.toMatch(/\n/);
      expect(stripped).not.toMatch(/\r/);
      // ヘッダ区切り空行 (\r\n\r\n) の存在も確認
      expect(decoded).toContain("\r\n\r\n");
    });
  });

  describe("Cc 配列の扱い (Phase 3 完了条件)", () => {
    it("Cc 空配列 → Cc: ヘッダを出さない", () => {
      const raw = buildCompletionMime({
        fromEmail: "from@x.com",
        to: "to@x.com",
        cc: [],
        subject: "s",
        body: "b",
      });
      const decoded = base64UrlDecode(raw);
      expect(decoded).not.toMatch(/^Cc:/m);
    });

    it("Cc 1 件 → Cc: 単一", () => {
      const raw = buildCompletionMime({
        fromEmail: "from@x.com",
        to: "to@x.com",
        cc: ["cc1@x.com"],
        subject: "s",
        body: "b",
      });
      const decoded = base64UrlDecode(raw);
      expect(decoded).toContain("Cc: cc1@x.com");
    });

    it("Cc 複数 → カンマ + 半角空白で連結", () => {
      const raw = buildCompletionMime({
        fromEmail: "from@x.com",
        to: "to@x.com",
        cc: ["a@x.com", "b@x.com", "c@x.com"],
        subject: "s",
        body: "b",
      });
      const decoded = base64UrlDecode(raw);
      expect(decoded).toContain("Cc: a@x.com, b@x.com, c@x.com");
    });
  });

  describe("CR/LF header injection 防御", () => {
    // defaults を先に展開し、`partial` で override する形にして同 key 重複指定を回避
    // (TS2783 "specified more than once" を防ぐ。order matters: spread が後)
    const mimeDefaults = {
      fromEmail: "f@x.com",
      to: "t@x.com",
      cc: [] as readonly string[],
      subject: "s",
      body: "b",
    };
    it.each([
      ["fromEmail", { fromEmail: "evil@x.com\r\nBcc: leak@x.com" }],
      ["to", { to: "evil@x.com\r\nBcc: leak@x.com" }],
      ["subject", { subject: "s\r\nX-Inject: 1" }],
    ])("%s に CR/LF を含めば throw", (_label, partial) => {
      expect(() =>
        buildCompletionMime({ ...mimeDefaults, ...partial }),
      ).toThrow();
    });

    it("Cc[] に CR/LF があれば throw", () => {
      expect(() =>
        buildCompletionMime({
          fromEmail: "f@x.com",
          to: "t@x.com",
          cc: ["good@x.com", "evil@x.com\nBcc: leak@x.com"],
          subject: "s",
          body: "b",
        }),
      ).toThrow();
    });

    it("body 内 CR/LF は許容 (base64 化されるため安全)", () => {
      expect(() =>
        buildCompletionMime({
          fromEmail: "f@x.com",
          to: "t@x.com",
          cc: [],
          subject: "s",
          body: "line1\r\nline2",
        }),
      ).not.toThrow();
    });
  });

  describe("型 validation", () => {
    it("fromEmail が空文字なら throw", () => {
      expect(() =>
        buildCompletionMime({
          fromEmail: "",
          to: "t@x.com",
          cc: [],
          subject: "s",
          body: "b",
        }),
      ).toThrow(/fromEmail/);
    });

    it("cc が非配列なら throw", () => {
      expect(() =>
        buildCompletionMime({
          fromEmail: "f@x.com",
          to: "t@x.com",
          // @ts-expect-error 非配列注入
          cc: "cc@x.com",
          subject: "s",
          body: "b",
        }),
      ).toThrow(/cc must be an array/);
    });
  });
});

// テスト全体で再利用する base input (重複定義を排除、safe-refactor M-3 反映)
const BASE_INPUT = {
  subjectEmail: "system@279279.net",
  fromEmail: "dxcollege@279279.net",
  to: "student@example.com",
  cc: [] as readonly string[],
  subject: "テスト件名",
  body: "本文",
};

describe("sendCompletionMail (retry / success)", () => {
  beforeEach(() => {
    setSecretManagerOk();
  });

  // owner CC 入りの retry / success ケース用
  const baseInput = { ...BASE_INPUT, cc: ["owner@example.com"] as readonly string[] };

  it("1 回目で成功 → attempts=1、messageId 返却", async () => {
    gmailSendMock.mockResolvedValueOnce({ data: { id: "msg-001" } });
    const result = await sendCompletionMail(baseInput);
    expect(result).toEqual({ messageId: "msg-001", attempts: 1 });
    expect(gmailSendMock).toHaveBeenCalledTimes(1);
  });

  it("429 1 回 → 2 回目成功 → attempts=2、sleep 1 回", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    gmailSendMock
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ data: { id: "msg-002" } });
    const result = await sendCompletionMail(baseInput, { sleep: sleepMock });
    expect(result).toEqual({ messageId: "msg-002", attempts: 2 });
    expect(gmailSendMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(500); // BACKOFF_INITIAL_MS
  });

  it("429 → 503 → 成功 → attempts=3、backoff 2 回 (500ms, 1000ms)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    gmailSendMock
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: { id: "msg-003" } });
    const result = await sendCompletionMail(baseInput, { sleep: sleepMock });
    expect(result).toEqual({ messageId: "msg-003", attempts: 3 });
    expect(sleepMock.mock.calls).toEqual([[500], [1000]]); // exponential
  });

  it("429 3 回連続 → throw (最後の error)、sleep 2 回 (最後の attempt 後は sleep しない)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    gmailSendMock
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ response: { status: 429 }, message: "final" });
    await expect(
      sendCompletionMail(baseInput, { sleep: sleepMock }),
    ).rejects.toMatchObject({ response: { status: 429 } });
    expect(gmailSendMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2); // attempts 1, 2 の後のみ
  });

  it("ECONNRESET transient → retry 後成功", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    gmailSendMock
      .mockRejectedValueOnce({ code: "ECONNRESET" })
      .mockResolvedValueOnce({ data: { id: "msg-econn" } });
    const result = await sendCompletionMail(baseInput, { sleep: sleepMock });
    expect(result.messageId).toBe("msg-econn");
    expect(result.attempts).toBe(2);
  });

  it("503 単独 1 回 → 2 回目成功 (evaluator narrative 反映、独立 retry 確認)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    gmailSendMock
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: { id: "msg-503" } });
    const result = await sendCompletionMail(baseInput, { sleep: sleepMock });
    expect(result.messageId).toBe("msg-503");
    expect(result.attempts).toBe(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(500);
  });

  it("Secret Manager network error は transient 扱いせず caller に伝搬", async () => {
    accessSecretVersionMock.mockReset();
    accessSecretVersionMock.mockRejectedValue(
      Object.assign(new Error("network"), { code: "ECONNRESET" }),
    );
    await expect(sendCompletionMail(baseInput)).rejects.toThrow(/network/);
    // Gmail send 自体は実行されない
    expect(gmailSendMock).not.toHaveBeenCalled();
  });
});

describe("sendCompletionMail (permanent errors → 即時 throw)", () => {
  beforeEach(() => {
    setSecretManagerOk();
  });

  // BASE_INPUT を共有 (safe-refactor M-3 反映、重複排除)
  const baseInput = { ...BASE_INPUT, subject: "s", body: "b" };

  it.each([
    ["401 (token 失効)", 401],
    ["403 (scope/permission)", 403],
    ["400 (Bad Request)", 400],
    ["422 (Unprocessable)", 422],
  ])("%s → retry せず即時 throw", async (_label, status) => {
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    gmailSendMock.mockRejectedValueOnce({ response: { status } });
    await expect(
      sendCompletionMail(baseInput, { sleep: sleepMock }),
    ).rejects.toMatchObject({ response: { status } });
    expect(gmailSendMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("response.data.id が空 → throw", async () => {
    gmailSendMock.mockResolvedValueOnce({ data: { id: "" } });
    await expect(sendCompletionMail(baseInput)).rejects.toThrow(/messageId/);
  });

  it("response.data.id が undefined → throw", async () => {
    gmailSendMock.mockResolvedValueOnce({ data: {} });
    await expect(sendCompletionMail(baseInput)).rejects.toThrow(/messageId/);
  });
});

describe("sendCompletionMail (gmail-client 連携)", () => {
  beforeEach(() => {
    setSecretManagerOk();
  });

  it("getGmailClientForSender 経由で JWT subject=subjectEmail、scope=gmail.send のみ", async () => {
    gmailSendMock.mockResolvedValueOnce({ data: { id: "msg-jwt" } });
    await sendCompletionMail({
      subjectEmail: "system@279279.net",
      fromEmail: "dxcollege@279279.net",
      to: "s@x.com",
      cc: [],
      subject: "s",
      body: "b",
    });

    expect(jwtConstructorMock).toHaveBeenCalledTimes(1);
    const jwtArgs = jwtConstructorMock.mock.calls[0][0] as {
      subject: string;
      scopes: string[];
    };
    expect(jwtArgs.subject).toBe("system@279279.net");
    expect(jwtArgs.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });

  it("gmail.users.messages.send は raw=base64url MIME を渡す", async () => {
    gmailSendMock.mockResolvedValueOnce({ data: { id: "msg-mime" } });
    await sendCompletionMail({
      subjectEmail: "system@279279.net",
      fromEmail: "dxcollege@279279.net",
      to: "s@x.com",
      cc: ["cc@x.com"],
      subject: "件名",
      body: "本文",
    });

    const sendArgs = gmailSendMock.mock.calls[0][0] as {
      userId: string;
      requestBody: { raw: string };
    };
    expect(sendArgs.userId).toBe("me");
    expect(sendArgs.requestBody.raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url chars
    const decoded = base64UrlDecode(sendArgs.requestBody.raw);
    expect(decoded).toContain("From: dxcollege@279279.net");
    expect(decoded).toContain("To: s@x.com");
    expect(decoded).toContain("Cc: cc@x.com");
  });
});
