/**
 * gmail-client の単体テスト。
 *
 * 設計仕様書 §5.3、FR-5 (改訂)、NFR-9 (改訂)、AC-3 / AC-34 に対応。
 * Codex Important-1 反映: 既存共通 SCOPES と分離した専用 client であること、
 * cache key が (subject, scope) で一意化されることを保証する。
 *
 * 観点:
 *   - 引数 validation (空文字 / 非 string)
 *   - DWD JWT が gmail.send scope のみで生成される
 *   - subject 同一なら同一クライアント (cache hit)
 *   - subject 異なれば別クライアント (cache miss)
 *   - fromEmail が異なるだけでは subject 同一なら同一クライアント
 *     (= cache key は (subject, scope) のみで fromEmail は含まない、ADR-037 §実装方針)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const jwtConstructorMock = vi.hoisted(() => vi.fn());
const gmailConstructorMock = vi.hoisted(() => vi.fn());
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
      gmail: vi.fn((opts: Record<string, unknown>) => {
        gmailConstructorMock(opts);
        // 識別用にユニークオブジェクトを返す
        return { __id: Symbol("gmail-client-instance") };
      }),
    },
  };
});

vi.mock("@google-cloud/secret-manager", () => {
  class MockSecretManagerServiceClient {
    accessSecretVersion = accessSecretVersionMock;
  }
  return { SecretManagerServiceClient: MockSecretManagerServiceClient };
});

const {
  getGmailClientForSender,
  DISPATCH_GMAIL_SCOPE,
  __getCacheStatsForTest,
  __resetCacheForTest,
} = await import("../gmail-client.js");

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
  gmailConstructorMock.mockClear();
  accessSecretVersionMock.mockReset();
});

describe("DISPATCH_GMAIL_SCOPE", () => {
  it("gmail.send scope のみ (共通 SCOPES と独立)", () => {
    expect(DISPATCH_GMAIL_SCOPE).toBe("https://www.googleapis.com/auth/gmail.send");
  });
});

describe("getGmailClientForSender 引数 validation", () => {
  beforeEach(() => setSecretManagerOk());

  it("subjectEmail が空文字なら throw", async () => {
    await expect(
      getGmailClientForSender("", "dxcollege@279279.net"),
    ).rejects.toThrow(/subjectEmail/);
  });

  it("subjectEmail が string 以外なら throw", async () => {
    await expect(
      // @ts-expect-error: 型エラーをランタイムで検知することを確認
      getGmailClientForSender(null, "dxcollege@279279.net"),
    ).rejects.toThrow(/subjectEmail/);
  });

  it("fromEmail が空文字なら throw", async () => {
    await expect(
      getGmailClientForSender("system@279279.net", ""),
    ).rejects.toThrow(/fromEmail/);
  });
});

describe("getGmailClientForSender DWD 生成", () => {
  beforeEach(() => setSecretManagerOk());

  it("初回呼び出しで Secret Manager から鍵を読み JWT を生成", async () => {
    await getGmailClientForSender("system@279279.net", "dxcollege@279279.net");

    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1);
    expect(jwtConstructorMock).toHaveBeenCalledTimes(1);
    expect(jwtConstructorMock).toHaveBeenCalledWith({
      email: FAKE_KEY.client_email,
      key: FAKE_KEY.private_key,
      scopes: [DISPATCH_GMAIL_SCOPE],
      subject: "system@279279.net",
    });
  });

  it("scopes が gmail.send のみ (Drive/Docs/Sheets を含まない、Important-1)", async () => {
    await getGmailClientForSender("system@279279.net", "dxcollege@279279.net");
    const call = jwtConstructorMock.mock.calls[0][0] as { scopes: string[] };
    expect(call.scopes).toEqual([DISPATCH_GMAIL_SCOPE]);
    expect(call.scopes).not.toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(call.scopes).not.toContain("https://www.googleapis.com/auth/documents.readonly");
  });

  it("Secret Manager が payload を返さなければ throw", async () => {
    accessSecretVersionMock.mockResolvedValue([{ payload: undefined }]);
    await expect(
      getGmailClientForSender("system@279279.net", "dxcollege@279279.net"),
    ).rejects.toThrow(/Secret Manager/);
  });

  it("Secret Manager 返却 JSON に client_email が欠けていれば throw", async () => {
    accessSecretVersionMock.mockResolvedValue([
      { payload: { data: JSON.stringify({ private_key: "x" }) } },
    ]);
    await expect(
      getGmailClientForSender("system@279279.net", "dxcollege@279279.net"),
    ).rejects.toThrow(/malformed/);
  });
});

describe("cache 動作 (cache key = subject + scope)", () => {
  beforeEach(() => setSecretManagerOk());

  it("同一 subject の 2 回目呼び出しは Secret Manager / JWT を再実行しない", async () => {
    const a = await getGmailClientForSender("system@279279.net", "dxcollege@279279.net");
    const b = await getGmailClientForSender("system@279279.net", "dxcollege@279279.net");

    expect(a).toBe(b); // 同一参照
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1);
    expect(jwtConstructorMock).toHaveBeenCalledTimes(1);
  });

  it("subject が異なれば別クライアント (Secret Manager は鍵 cache 済なので 1 回のみ)", async () => {
    const a = await getGmailClientForSender("system@279279.net", "dxcollege@279279.net");
    const b = await getGmailClientForSender("other@279279.net", "dxcollege@279279.net");

    expect(a).not.toBe(b);
    expect(jwtConstructorMock).toHaveBeenCalledTimes(2);
    // Secret Manager は鍵 cache されるので 1 回のみ
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1);
  });

  it("fromEmail だけが異なる場合は cache hit (cache key は subject のみ)", async () => {
    const a = await getGmailClientForSender("system@279279.net", "dxcollege@279279.net");
    const b = await getGmailClientForSender("system@279279.net", "other-alias@279279.net");

    // ADR-037 §実装方針: cache key は (subject, scope) のみ、fromEmail は MIME 側で使う
    expect(a).toBe(b);
    expect(jwtConstructorMock).toHaveBeenCalledTimes(1);
  });

  it("__getCacheStatsForTest が cache 状態を返す", async () => {
    expect(__getCacheStatsForTest()).toEqual({ size: 0, keys: [] });
    await getGmailClientForSender("system@279279.net", "dxcollege@279279.net");
    expect(__getCacheStatsForTest()).toEqual({
      size: 1,
      keys: [`system@279279.net|${DISPATCH_GMAIL_SCOPE}`],
    });
  });
});
