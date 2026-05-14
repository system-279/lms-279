/**
 * gmail-draft の単体テスト。
 *
 * 観点:
 * - buildRawMimeMessage: MIME multipart 組み立て (添付あり/なし)
 * - encodeMimeHeader: RFC 2047 日本語 encode
 * - classifyGmailError: HTTP status → ProgressPdfDraftErrorCode マッピング
 * - createGmailDraft: googleapis モック経由で成功・失敗パスを検証
 * - buildGmailDraftUrl: ADR-034 §9 URL 形式
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const draftsCreateMock = vi.hoisted(() => vi.fn());
const oauth2SetCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials = oauth2SetCredentialsMock;
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: vi.fn(() => ({
        users: {
          drafts: {
            create: draftsCreateMock,
          },
        },
      })),
    },
  };
});

const {
  buildRawMimeMessage,
  classifyGmailError,
  buildGmailDraftUrl,
  createGmailDraft,
  GmailDraftError,
  __internal,
} = await import("../gmail-draft.js");

const { encodeMimeHeader } = __internal;

/** base64url decode (Node の Buffer は base64url を toString サポート) */
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

describe("buildRawMimeMessage", () => {
  it("添付なし: text/plain メッセージを base64url で返す", () => {
    const raw = buildRawMimeMessage({
      to: "owner@example.com",
      subject: "テスト件名",
      body: "テスト本文",
    });
    const decoded = base64UrlDecode(raw);
    expect(decoded).toContain("To: owner@example.com");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(decoded).toContain(Buffer.from("テスト本文", "utf-8").toString("base64"));
  });

  it("添付あり: multipart/mixed boundary を含む", () => {
    const pdfContent = Buffer.from("%PDF-1.4 fake pdf content", "utf-8");
    const raw = buildRawMimeMessage({
      to: "owner@example.com",
      subject: "進捗レポート",
      body: "ご確認ください",
      attachment: {
        filename: "progress-yamada-2026-05-14.pdf",
        contentType: "application/pdf",
        content: pdfContent,
      },
    });
    const decoded = base64UrlDecode(raw);
    expect(decoded).toMatch(/Content-Type: multipart\/mixed; boundary="lms279_boundary_\d+_[a-z0-9]+"/);
    expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(decoded).toContain("Content-Type: application/pdf");
    expect(decoded).toContain('Content-Disposition: attachment; filename="progress-yamada-2026-05-14.pdf"');
    expect(decoded).toContain(pdfContent.toString("base64"));
    expect(decoded).toMatch(/--lms279_boundary_\d+_[a-z0-9]+--/);
  });

  it("添付の日本語ファイル名は RFC 2047 で encode", () => {
    const raw = buildRawMimeMessage({
      to: "owner@example.com",
      subject: "件名",
      body: "本文",
      attachment: {
        filename: "進捗レポート.pdf",
        contentType: "application/pdf",
        content: Buffer.from("x"),
      },
    });
    const decoded = base64UrlDecode(raw);
    expect(decoded).toMatch(/filename="=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?="/);
  });

  it("base64url エンコードされ、+ / = が含まれない", () => {
    const raw = buildRawMimeMessage({
      to: "a@b.com",
      subject: "x",
      body: "y".repeat(200), // base64 で +/ が出やすい状況
    });
    expect(raw).not.toMatch(/[+/=]/);
  });
});

describe("buildRawMimeMessage CR/LF ヘッダインジェクション防御", () => {
  it("to に \\r\\n を含むと GmailDraftError (gmail_api_error, 400) を throw", () => {
    expect(() =>
      buildRawMimeMessage({
        to: "owner@example.com\r\nBcc: attacker@evil.com",
        subject: "件名",
        body: "本文",
      }),
    ).toThrow(GmailDraftError);
  });

  it("subject に \\n を含むと throw", () => {
    expect(() =>
      buildRawMimeMessage({
        to: "owner@example.com",
        subject: "件名\nX-Injected: yes",
        body: "本文",
      }),
    ).toThrow(/MIME header injection blocked: subject/);
  });

  it("attachment.filename に \\r\\n を含むと throw", () => {
    expect(() =>
      buildRawMimeMessage({
        to: "owner@example.com",
        subject: "件名",
        body: "本文",
        attachment: {
          filename: "evil.pdf\r\nContent-Type: text/html",
          contentType: "application/pdf",
          content: Buffer.from("x"),
        },
      }),
    ).toThrow(/MIME header injection blocked: attachment\.filename/);
  });

  it("attachment.contentType に \\n を含むと throw", () => {
    expect(() =>
      buildRawMimeMessage({
        to: "owner@example.com",
        subject: "件名",
        body: "本文",
        attachment: {
          filename: "ok.pdf",
          contentType: "application/pdf\nX-Injected: yes",
          content: Buffer.from("x"),
        },
      }),
    ).toThrow(/MIME header injection blocked: attachment\.contentType/);
  });

  it("body 内の \\n は許容される (base64 化されるため)", () => {
    const raw = buildRawMimeMessage({
      to: "owner@example.com",
      subject: "件名",
      body: "1 行目\n2 行目\r\n3 行目",
    });
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(0);
  });
});

describe("classifyGmailError", () => {
  it("401 → invalid_access_token", () => {
    const err = { response: { status: 401, data: { error: { message: "Invalid Credentials" } } } };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("invalid_access_token");
    expect(result.httpStatus).toBe(401);
  });

  it("403 + insufficient scope → gmail_scope_required", () => {
    const err = {
      response: {
        status: 403,
        data: {
          error: {
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
          },
        },
      },
    };
    expect(classifyGmailError(err).errorCode).toBe("gmail_scope_required");
  });

  it("403 + reason=insufficientPermissions → gmail_scope_required", () => {
    const err = {
      response: {
        status: 403,
        data: { error: { message: "Forbidden", errors: [{ reason: "insufficientPermissions" }] } },
      },
    };
    expect(classifyGmailError(err).errorCode).toBe("gmail_scope_required");
  });

  it("403 で scope と無関係 → gmail_api_error", () => {
    const err = {
      response: { status: 403, data: { error: { message: "User not found", errors: [{ reason: "notFound" }] } } },
    };
    expect(classifyGmailError(err).errorCode).toBe("gmail_api_error");
  });

  it("429 → gmail_quota_exceeded", () => {
    const err = { response: { status: 429, data: { error: { message: "Quota exceeded" } } } };
    expect(classifyGmailError(err).errorCode).toBe("gmail_quota_exceeded");
  });

  it("503 → gmail_api_transient", () => {
    const err = { response: { status: 503, data: { error: { message: "Service unavailable" } } } };
    expect(classifyGmailError(err).errorCode).toBe("gmail_api_transient");
  });

  it("500 → gmail_api_error (httpStatus=502 でラップ)", () => {
    const err = { response: { status: 500, data: { error: { message: "Internal" } } } };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("gmail_api_error");
    expect(result.httpStatus).toBe(502);
  });

  it("既存の GmailDraftError はそのまま返す", () => {
    const original = new GmailDraftError("test", "gmail_api_error", 502);
    expect(classifyGmailError(original)).toBe(original);
  });

  it("status 不明の error も gmail_api_error にフォールバック", () => {
    const err = new Error("network failure");
    expect(classifyGmailError(err).errorCode).toBe("gmail_api_error");
  });
});

describe("buildGmailDraftUrl", () => {
  it("ADR-034 §9 で確定した URL 形式", () => {
    expect(buildGmailDraftUrl("r-12345")).toBe("https://mail.google.com/mail/u/0/?ogbl#drafts/r-12345");
  });
});

describe("createGmailDraft (googleapis mocked)", () => {
  beforeEach(() => {
    draftsCreateMock.mockReset();
    oauth2SetCredentialsMock.mockReset();
  });

  it("成功時 draftId と draftUrl を返す", async () => {
    draftsCreateMock.mockResolvedValueOnce({ data: { id: "draft_xyz" } });

    const result = await createGmailDraft({
      accessToken: "ya29.test_token",
      to: "owner@example.com",
      subject: "件名",
      body: "本文",
    });

    expect(result.draftId).toBe("draft_xyz");
    expect(result.draftUrl).toBe("https://mail.google.com/mail/u/0/?ogbl#drafts/draft_xyz");
    expect(oauth2SetCredentialsMock).toHaveBeenCalledWith({ access_token: "ya29.test_token" });
    expect(draftsCreateMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: expect.objectContaining({
        message: expect.objectContaining({ raw: expect.any(String) }),
      }),
    });
  });

  it("accessToken が空文字 → invalid_access_token (400)", async () => {
    await expect(
      createGmailDraft({ accessToken: "", to: "a@b.com", subject: "x", body: "y" }),
    ).rejects.toMatchObject({
      errorCode: "invalid_access_token",
      httpStatus: 400,
    });
    expect(draftsCreateMock).not.toHaveBeenCalled();
  });

  it("Gmail API 403 + insufficient scope → gmail_scope_required", async () => {
    draftsCreateMock.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: {
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
          },
        },
      },
    });

    await expect(
      createGmailDraft({ accessToken: "t", to: "a@b.com", subject: "x", body: "y" }),
    ).rejects.toMatchObject({ errorCode: "gmail_scope_required", httpStatus: 403 });
  });

  it("draft id が返ってこない場合 gmail_api_error (502)", async () => {
    draftsCreateMock.mockResolvedValueOnce({ data: {} });

    await expect(
      createGmailDraft({ accessToken: "t", to: "a@b.com", subject: "x", body: "y" }),
    ).rejects.toMatchObject({ errorCode: "gmail_api_error", httpStatus: 502 });
  });

  it("添付ありで MIME を組み立てて raw に渡す", async () => {
    draftsCreateMock.mockResolvedValueOnce({ data: { id: "d1" } });

    await createGmailDraft({
      accessToken: "t",
      to: "owner@example.com",
      subject: "進捗",
      body: "ご確認ください",
      attachment: {
        filename: "progress.pdf",
        contentType: "application/pdf",
        content: Buffer.from("%PDF-1.4"),
      },
    });

    const call = draftsCreateMock.mock.calls[0][0];
    const raw = call.requestBody.message.raw;
    const decoded = base64UrlDecode(raw);
    expect(decoded).toContain("Content-Type: multipart/mixed");
    expect(decoded).toContain("Content-Type: application/pdf");
    expect(decoded).toContain('filename="progress.pdf"');
  });
});
