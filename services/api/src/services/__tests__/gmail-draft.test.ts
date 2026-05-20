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
const tokeninfoMock = vi.hoisted(() => vi.fn());

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
      oauth2: vi.fn(() => ({
        tokeninfo: tokeninfoMock,
      })),
    },
  };
});

const {
  buildRawMimeMessage,
  classifyGmailError,
  buildGmailDraftUrl,
  createGmailDraft,
  verifyAccessTokenOwner,
  GmailDraftError,
  GMAIL_ERROR_PUBLIC_MESSAGES,
  TRANSIENT_NETWORK_CODES,
  __internal,
} = await import("../gmail-draft.js");

const {
  encodeMimeHeader,
  buildFilenameParam,
  rfc5987Encode,
  assertSafeFilename,
} = __internal;

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

  it("添付の日本語ファイル名は filename に生 Unicode + filename*= の dual-form を出力 (2026 best practice)", () => {
    const original = "進捗レポート.pdf";
    const raw = buildRawMimeMessage({
      to: "owner@example.com",
      subject: "件名",
      body: "本文",
      attachment: {
        filename: original,
        contentType: "application/pdf",
        content: Buffer.from("x"),
      },
    });
    const decoded = base64UrlDecode(raw);

    // RFC 2047 §5 違反 (encoded-word を parameter value に詰める) パターン不発
    expect(decoded).not.toMatch(/filename="=\?UTF-8\?B\?/);

    // ASCII fallback (_____.pdf) を使わず、filename には生 Unicode を quoted-string で出力
    // (RFC 5322 厳密違反だが Gmail/Outlook/Apple Mail の業界 de facto 受理)
    const expectedEncoded = rfc5987Encode(original);
    expect(decoded).toContain(
      `Content-Disposition: attachment; filename="${original}"; filename*=UTF-8''${expectedEncoded}`,
    );
    // 旧仕様 (`_` 連続 ASCII fallback) への退行を防止
    expect(decoded).not.toMatch(/filename="_+\.pdf"/);
    // RFC 2046 deprecated な Content-Type `name=` は発行しない
    expect(decoded).toContain("Content-Type: application/pdf\r\n");
    expect(decoded).not.toMatch(/Content-Type: application\/pdf;/);
  });

  it("ASCII のみのファイル名は dual-form にせずシンプル形式 (filename=\"...\") のみ", () => {
    const raw = buildRawMimeMessage({
      to: "owner@example.com",
      subject: "件名",
      body: "本文",
      attachment: {
        filename: "progress-2026-05-15.pdf",
        contentType: "application/pdf",
        content: Buffer.from("x"),
      },
    });
    const decoded = base64UrlDecode(raw);
    expect(decoded).toContain(
      'Content-Disposition: attachment; filename="progress-2026-05-15.pdf"',
    );
    expect(decoded).toContain("Content-Type: application/pdf\r\n");
    // filename*= / name= (RFC 2046 deprecated) / name*= は出力されないこと
    // 単語境界で filename= 中の name= を hit しないよう ; or 行頭の直後を要求
    expect(decoded).not.toMatch(/filename\*=/);
    expect(decoded).not.toMatch(/(?:^|;\s)name=/);
    expect(decoded).not.toMatch(/(?:^|;\s)name\*=/);
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

describe("rfc5987Encode (RFC 5987 §3.2.1 attr-char 準拠)", () => {
  it("encodeURIComponent が残す ! ' ( ) * も追加で percent-encode", () => {
    expect(rfc5987Encode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("ASCII safe な文字はそのまま", () => {
    expect(rfc5987Encode("progress-2026-05.pdf")).toBe("progress-2026-05.pdf");
  });

  it("絵文字 (U+1F680) は UTF-8 4 byte sequence で正しく percent-encode (lone surrogate に分解しない)", () => {
    // 🚀 (U+1F680) は UTF-8 で F0 9F 9A 80
    expect(rfc5987Encode("🚀.pdf")).toBe("%F0%9F%9A%80.pdf");
  });

  it("日本語をそのまま percent-encode", () => {
    expect(rfc5987Encode("テスト.pdf")).toBe("%E3%83%86%E3%82%B9%E3%83%88.pdf");
  });
});

describe("assertSafeFilename (制御文字 + lone surrogate 防御)", () => {
  it("ASCII / 日本語 / 絵文字は throw しない", () => {
    expect(() => assertSafeFilename("progress.pdf")).not.toThrow();
    expect(() => assertSafeFilename("進捗.pdf")).not.toThrow();
    expect(() => assertSafeFilename("🚀.pdf")).not.toThrow();
  });

  it("空文字は throw しない (route 層で必須化済の前提)", () => {
    expect(() => assertSafeFilename("")).not.toThrow();
  });

  it("NUL (\\x00) を含むと throw (一部 MUA で truncate される)", () => {
    expect(() => assertSafeFilename("a\x00b.pdf")).toThrow(/Invalid filename/);
  });

  it("ESC (\\x1b) / BEL (\\x07) など C0 制御文字を含むと throw", () => {
    expect(() => assertSafeFilename("a\x1bb.pdf")).toThrow(/Invalid filename/);
    expect(() => assertSafeFilename("a\x07b.pdf")).toThrow(/Invalid filename/);
  });

  it("DEL (\\x7f) を含むと throw", () => {
    expect(() => assertSafeFilename("a\x7fb.pdf")).toThrow(/Invalid filename/);
  });

  it("lone high surrogate を含むと throw (encodeURIComponent URIError 防御)", () => {
    expect(() => assertSafeFilename("a\uD83Db.pdf")).toThrow(/lone surrogate/);
  });

  it("lone low surrogate を含むと throw", () => {
    expect(() => assertSafeFilename("a\uDC00b.pdf")).toThrow(/lone surrogate/);
  });

  it("valid surrogate pair (絵文字) は throw しない", () => {
    expect(() => assertSafeFilename("🚀.pdf")).not.toThrow();
  });
});

describe("buildFilenameParam (2026 業界 best practice: filename に生 Unicode + filename*= dual-form)", () => {
  it("ASCII のみは filename=\"...\" 単体形式", () => {
    expect(buildFilenameParam("filename", "progress.pdf")).toBe('filename="progress.pdf"');
    expect(buildFilenameParam("name", "report-2026.pdf")).toBe('name="report-2026.pdf"');
  });

  it("ASCII 内の _ はそのまま (fallback char と衝突しない)", () => {
    expect(buildFilenameParam("filename", "my_progress_2026.pdf")).toBe(
      'filename="my_progress_2026.pdf"',
    );
  });

  it("日本語を含む場合は filename に生 Unicode + filename*=UTF-8'' の dual-form", () => {
    const original = "進捗レポート.pdf";
    expect(buildFilenameParam("filename", original)).toBe(
      `filename="${original}"; filename*=UTF-8''${rfc5987Encode(original)}`,
    );
  });

  it("絵文字 (surrogate pair) も filename に生 Unicode + RFC 5987 4-byte percent-encode", () => {
    const result = buildFilenameParam("filename", "🚀.pdf");
    expect(result).toBe("filename=\"🚀.pdf\"; filename*=UTF-8''%F0%9F%9A%80.pdf");
  });

  it("ASCII 内の \" は escape", () => {
    expect(buildFilenameParam("filename", 'has"quote.pdf')).toBe(
      'filename="has\\"quote.pdf"',
    );
  });

  it("ASCII 内の \\ は RFC 5322 quoted-pair で escape", () => {
    expect(buildFilenameParam("filename", 'a\\b.pdf')).toBe(
      'filename="a\\\\b.pdf"',
    );
  });

  it("非 ASCII + \" 両方を含む値: filename 側は \" を \\\" escape、filename*= は %22", () => {
    const result = buildFilenameParam("filename", 'テス"ト.pdf');
    expect(result).toBe(
      `filename="テス\\"ト.pdf"; filename*=UTF-8''${rfc5987Encode('テス"ト.pdf')}`,
    );
  });

  it("RFC 5987 attr-char 外の文字 ( ' ( ) * ! ) を含む場合は filename*= 側で percent-encode", () => {
    const result = buildFilenameParam("filename", "テ'ス(ト).pdf");
    expect(result).toContain("%27"); // '
    expect(result).toContain("%28"); // (
    expect(result).toContain("%29"); // )
    // filename 側 (生 Unicode) は escape せず元のまま (RFC 5322 quoted-string で許容)
    expect(result).toContain(`filename="テ'ス(ト).pdf"`);
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

describe("buildRawMimeMessage CC ヘッダサポート (案 B、Issue #433)", () => {
  /** base64url を復号して MIME 文字列を取得するヘルパー */
  function decodeMime(raw: string): string {
    return Buffer.from(raw, "base64url").toString("utf-8");
  }

  it("AC-2: cc を渡すと添付なしメッセージに `Cc:` ヘッダが入る", () => {
    const raw = buildRawMimeMessage({
      to: "student@example.com",
      cc: "owner@example.com",
      subject: "件名",
      body: "本文",
    });
    const mime = decodeMime(raw);
    expect(mime).toMatch(/^To: student@example\.com\r\nCc: owner@example\.com\r\n/);
  });

  it("AC-2: cc を渡すと添付ありメッセージにも `Cc:` ヘッダが入る", () => {
    const raw = buildRawMimeMessage({
      to: "student@example.com",
      cc: "owner@example.com",
      subject: "件名",
      body: "本文",
      attachment: {
        filename: "report.pdf",
        contentType: "application/pdf",
        content: Buffer.from("pdf-content"),
      },
    });
    const mime = decodeMime(raw);
    expect(mime).toContain("To: student@example.com\r\nCc: owner@example.com\r\n");
  });

  it("AC-3: cc が undefined なら `Cc:` ヘッダ行を出さない", () => {
    const raw = buildRawMimeMessage({
      to: "student@example.com",
      subject: "件名",
      body: "本文",
    });
    const mime = decodeMime(raw);
    expect(mime).not.toMatch(/^Cc:/m);
    expect(mime).toContain("To: student@example.com\r\nSubject:");
  });

  it("AC-3: cc が空文字なら `Cc:` ヘッダ行を出さない", () => {
    const raw = buildRawMimeMessage({
      to: "student@example.com",
      cc: "",
      subject: "件名",
      body: "本文",
    });
    const mime = decodeMime(raw);
    expect(mime).not.toMatch(/^Cc:/m);
  });

  it("AC-3: cc が全空白文字 (trim 後空) なら `Cc:` ヘッダ行を出さない", () => {
    const raw = buildRawMimeMessage({
      to: "student@example.com",
      cc: "   \t  ",
      subject: "件名",
      body: "本文",
    });
    const mime = decodeMime(raw);
    expect(mime).not.toMatch(/^Cc:/m);
  });

  it("cc は trim されてから MIME に出力される", () => {
    const raw = buildRawMimeMessage({
      to: "student@example.com",
      cc: "  owner@example.com  ",
      subject: "件名",
      body: "本文",
    });
    const mime = decodeMime(raw);
    expect(mime).toContain("Cc: owner@example.com\r\n");
    expect(mime).not.toContain("Cc:   owner@example.com");
  });

  it("AC-5: cc に \\r\\n を含むと GmailDraftError (gmail_api_error, 400) を throw", () => {
    expect(() =>
      buildRawMimeMessage({
        to: "student@example.com",
        cc: "owner@example.com\r\nBcc: attacker@evil.com",
        subject: "件名",
        body: "本文",
      }),
    ).toThrow(GmailDraftError);
    expect(() =>
      buildRawMimeMessage({
        to: "student@example.com",
        cc: "owner@example.com\r\nBcc: attacker@evil.com",
        subject: "件名",
        body: "本文",
      }),
    ).toThrow(/MIME header injection blocked: cc/);
  });

  it("AC-5: cc に \\n のみでも throw", () => {
    expect(() =>
      buildRawMimeMessage({
        to: "student@example.com",
        cc: "owner@example.com\nX-Injected: yes",
        subject: "件名",
        body: "本文",
      }),
    ).toThrow(/MIME header injection blocked: cc/);
  });
});

describe("buildRawMimeMessage attachment.filename 制御文字 / surrogate 防御", () => {
  const validBody = {
    to: "owner@example.com",
    subject: "件名",
    body: "本文",
  };

  it("filename に NUL を含むと GmailDraftError を throw (gmail_api_error への誤分類を防ぐ)", () => {
    expect(() =>
      buildRawMimeMessage({
        ...validBody,
        attachment: {
          filename: "a\x00b.pdf",
          contentType: "application/pdf",
          content: Buffer.from("x"),
        },
      }),
    ).toThrow(/control character/);
  });

  it("filename に lone surrogate を含むと throw (encodeURIComponent URIError を未然防御)", () => {
    expect(() =>
      buildRawMimeMessage({
        ...validBody,
        attachment: {
          filename: "a\uD83Db.pdf",
          contentType: "application/pdf",
          content: Buffer.from("x"),
        },
      }),
    ).toThrow(/lone surrogate/);
  });

  it("filename が空文字でも throw しない (route 層責務とする)", () => {
    expect(() =>
      buildRawMimeMessage({
        ...validBody,
        attachment: {
          filename: "",
          contentType: "application/pdf",
          content: Buffer.from("x"),
        },
      }),
    ).not.toThrow();
  });

  // route 層 sanitize 漏れ時の library 出力を pin する退行マーカー。
  // 空文字 filename は Gmail UI で UUID fallback を誘発する観測ありで、
  // 万が一 buildProgressPdfFilename が空文字を返すバグが入ったら、
  // 本テストが「想定の MIME 形」を示し、route 側で 422 reject 等の対処判断を促す。
  it("filename が空文字なら filename=\"\" として出力し、退行は MIME pin で検知", () => {
    const raw = buildRawMimeMessage({
      ...validBody,
      attachment: {
        filename: "",
        contentType: "application/pdf",
        content: Buffer.from("x"),
      },
    });
    const decoded = base64UrlDecode(raw);
    expect(decoded).toContain('Content-Disposition: attachment; filename=""');
    // 空文字は ASCII 単独 form (dual-form 経路に入らない)
    expect(decoded).not.toMatch(/filename\*=/);
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

describe("classifyGmailError: network error (string code) → transient", () => {
  // Node.js / undici の transport error code を gmail_api_transient に分類する。
  // 参考: rules/error-handling.md §3 — ECONNRESET / ETIMEDOUT 等は transient
  // 実装側 (gmail-draft.ts) の TRANSIENT_NETWORK_CODES を参照し、定義二重化を避ける。
  const TRANSIENT_CASES = Array.from(TRANSIENT_NETWORK_CODES);

  it.each(TRANSIENT_CASES)("e.code === %s → gmail_api_transient (httpStatus 503)", (code) => {
    const err = { code, message: `${code}: connection issue` };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("gmail_api_transient");
    expect(result.httpStatus).toBe(503);
  });

  it("e.cause.code === ECONNRESET のみ (e.code なし) → gmail_api_transient", () => {
    const err = { cause: { code: "ECONNRESET" }, message: "fetch failed" };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("gmail_api_transient");
    expect(result.httpStatus).toBe(503);
  });

  it("response.status=503 + e.code=ECONNRESET 両存在 → HTTP status 優先で gmail_api_transient", () => {
    const err = {
      response: { status: 503, data: { error: { message: "Service unavailable" } } },
      code: "ECONNRESET",
    };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("gmail_api_transient");
    expect(result.httpStatus).toBe(503);
  });

  it("response.status=429 + e.code=ECONNRESET → HTTP status 優先で gmail_quota_exceeded (429)", () => {
    // undici の retry レイヤーで rate-limit 検出後にコネクションが切れたケース。
    // HTTP status (429) が確定しているので API レイヤ分類を優先し、
    // transport code (ECONNRESET) で transient 503 に降格させない。
    const err = {
      response: { status: 429, data: { error: { message: "Quota exceeded" } } },
      code: "ECONNRESET",
    };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("gmail_quota_exceeded");
    expect(result.httpStatus).toBe(429);
  });

  it("未知の string code (EUNKNOWN) → gmail_api_error (httpStatus 502)、過剰分類しない", () => {
    const err = { code: "EUNKNOWN", message: "unknown error" };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("gmail_api_error");
    expect(result.httpStatus).toBe(502);
  });

  it("e.code === '503' (string number) → 既存経路で gmail_api_transient (回帰なし)", () => {
    const err = { code: "503", message: "Service unavailable" };
    const result = classifyGmailError(err);
    expect(result.errorCode).toBe("gmail_api_transient");
    expect(result.httpStatus).toBe(503);
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

// Issue #436: access token の発行元 Google アカウント email を取得する関数。
// Gmail API 呼び出しと同じエラー分類 (classifyGmailError) を共有する。
describe("verifyAccessTokenOwner (Issue #436)", () => {
  beforeEach(() => {
    tokeninfoMock.mockReset();
    oauth2SetCredentialsMock.mockReset();
  });

  it("成功時: trim + lowercase した email と verified フラグを返す", async () => {
    tokeninfoMock.mockResolvedValueOnce({
      data: { email: "  User@Example.COM  ", verified_email: true },
    });

    const result = await verifyAccessTokenOwner("ya29.token");

    expect(result).toEqual({ email: "user@example.com", verified: true });
    expect(oauth2SetCredentialsMock).toHaveBeenCalledWith({ access_token: "ya29.token" });
    expect(tokeninfoMock).toHaveBeenCalledWith({ access_token: "ya29.token" });
  });

  it("verified_email が undefined のときは verified=false", async () => {
    tokeninfoMock.mockResolvedValueOnce({
      data: { email: "u@example.com" },
    });

    const result = await verifyAccessTokenOwner("ya29.token");
    expect(result.verified).toBe(false);
  });

  it("accessToken 空文字 → invalid_access_token (400) を throw + tokeninfo 呼ばれない", async () => {
    await expect(verifyAccessTokenOwner("")).rejects.toMatchObject({
      errorCode: "invalid_access_token",
      httpStatus: 400,
    });
    expect(tokeninfoMock).not.toHaveBeenCalled();
  });

  it("tokeninfo が email 無し → invalid_access_token (401)", async () => {
    tokeninfoMock.mockResolvedValueOnce({ data: {} });

    await expect(verifyAccessTokenOwner("ya29.token")).rejects.toMatchObject({
      errorCode: "invalid_access_token",
      httpStatus: 401,
    });
  });

  it("401 (token 無効/期限切れ) → invalid_access_token (401) に分類", async () => {
    tokeninfoMock.mockRejectedValueOnce({
      response: { status: 401, data: { error: { message: "invalid token" } } },
    });

    await expect(verifyAccessTokenOwner("ya29.token")).rejects.toMatchObject({
      errorCode: "invalid_access_token",
      httpStatus: 401,
    });
  });

  it("503 (transient) → gmail_api_transient (503) に分類", async () => {
    tokeninfoMock.mockRejectedValueOnce({
      response: { status: 503, data: { error: { message: "service unavailable" } } },
    });

    await expect(verifyAccessTokenOwner("ya29.token")).rejects.toMatchObject({
      errorCode: "gmail_api_transient",
      httpStatus: 503,
    });
  });

  it("network ECONNRESET → gmail_api_transient (503)", async () => {
    tokeninfoMock.mockRejectedValueOnce({ code: "ECONNRESET", message: "reset" });

    await expect(verifyAccessTokenOwner("ya29.token")).rejects.toMatchObject({
      errorCode: "gmail_api_transient",
      httpStatus: 503,
    });
  });

  it("5xx → gmail_api_error (502)", async () => {
    tokeninfoMock.mockRejectedValueOnce({
      response: { status: 500, data: { error: { message: "internal" } } },
    });

    await expect(verifyAccessTokenOwner("ya29.token")).rejects.toMatchObject({
      errorCode: "gmail_api_error",
      httpStatus: 502,
    });
  });
});

// Issue #437: PII フィルタ。Gmail API raw error message (受講者 email や MIME 断片を含む可能性) を
// 外部 (logger / HTTP レスポンス) に露出させないため、固定文言の publicMessage を別途持つ。
describe("GmailDraftError.publicMessage (Issue #437)", () => {
  it("AC-1: 各 errorCode に対応する固定文言が GMAIL_ERROR_PUBLIC_MESSAGES から取得される", () => {
    const err = new GmailDraftError("raw api error", "gmail_scope_required", 403);
    expect(err.publicMessage).toBe(GMAIL_ERROR_PUBLIC_MESSAGES.gmail_scope_required);
    // raw message と publicMessage は分離されている (Issue #437 の要)
    expect(err.publicMessage).not.toBe(err.message);
  });

  it("AC-1: GMAIL_ERROR_PUBLIC_MESSAGES の各値に PII リテラル (@ / .com 等の email-like 文字列) が含まれない", () => {
    for (const [code, msg] of Object.entries(GMAIL_ERROR_PUBLIC_MESSAGES)) {
      // 各固定文言はテンプレート的に安全な文字列であること
      expect(msg, `${code} publicMessage`).not.toMatch(/[\w.-]+@[\w.-]+/);
    }
  });

  it("AC-5: raw email を含む Gmail API error を classifyGmailError に渡しても publicMessage に PII が含まれない", () => {
    const piiEmail = "victim@example.com";
    // Gmail API が返す error message に raw email が含まれているケースをシミュレート
    const gaxiosError = {
      response: {
        status: 502,
        data: {
          error: {
            message: `Cannot send to ${piiEmail}: invalid recipient (MIME header issue)`,
          },
        },
      },
    };

    const classified = classifyGmailError(gaxiosError);

    // 内部診断用 message には raw が残る (logger.error から外す責任は呼び出し側)
    expect(classified.message).toContain(piiEmail);
    // publicMessage は固定文言なので PII は含まれない
    expect(classified.publicMessage).not.toContain(piiEmail);
    expect(classified.publicMessage).not.toContain("@");
    expect(classified.publicMessage).toBe(GMAIL_ERROR_PUBLIC_MESSAGES.gmail_api_error);
  });

  it("AC-5: scope 不足エラーで raw account info が含まれていても publicMessage は固定文言", () => {
    const gaxiosError = {
      response: {
        status: 403,
        data: {
          error: {
            message: "insufficientPermissions for account admin@victim-tenant.com",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    };

    const classified = classifyGmailError(gaxiosError);

    expect(classified.errorCode).toBe("gmail_scope_required");
    expect(classified.publicMessage).toBe(GMAIL_ERROR_PUBLIC_MESSAGES.gmail_scope_required);
    expect(classified.publicMessage).not.toContain("admin@");
    expect(classified.publicMessage).not.toContain("victim-tenant");
  });

  it("不明な errorCode (fallback) でも publicMessage は固定文言を返す", () => {
    // ProgressPdfDraftErrorCode に存在しない code (テスト上のみ) → fallback
    // 型システム上は通らないが、ランタイム安全性として確認
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = new GmailDraftError("raw", "non_existent_code" as any, 500);
    expect(err.publicMessage).toBe("Gmail API error");
  });
});
