/**
 * oidc-verify の単体 + Integration テスト。
 *
 * 設計仕様書 §3.1 / NFR-2 / AC-30 に対応。
 *
 * 観点:
 *   - extractBearerToken: 空 / 形式違反 / 正常
 *   - verifyOidcToken (mock verifier): success / audience_mismatch / expired / invalid
 *   - requireValidOidcToken middleware: 401 + ADR-010 フラットエラー形式、success で req.oidcCaller セット
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  extractBearerToken,
  OidcVerifyFailure,
  requireValidOidcToken,
  verifyOidcToken,
  type OidcTokenVerifier,
  type VerifiedOidcCaller,
} from "../oidc-verify.js";

const AUDIENCE = "https://api.example.com/api/v2/internal/dispatch/run-completion-notifications";

const SUCCESS_CALLER: VerifiedOidcCaller = {
  email: "dxcollege-scheduler@lms-279.iam.gserviceaccount.com",
  subject: "1234567890",
  audience: AUDIENCE,
};

function makeMockVerifier(
  impl: OidcTokenVerifier["verify"],
): OidcTokenVerifier {
  return { verify: impl };
}

describe("extractBearerToken", () => {
  it("正常な Bearer header → token 抽出", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("ケース不感 (bearer / BEARER 等も受理)", () => {
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("BEARER xyz")).toBe("xyz");
  });

  it("複数空白 / tab も separator として受理", () => {
    expect(extractBearerToken("Bearer  \t  abc.def")).toBe("abc.def");
  });

  it("undefined header → missing_authorization", () => {
    expect(() => extractBearerToken(undefined)).toThrow(OidcVerifyFailure);
    try {
      extractBearerToken(undefined);
    } catch (err) {
      expect((err as OidcVerifyFailure).code).toBe("missing_authorization");
    }
  });

  it("空文字 header → missing_authorization", () => {
    try {
      extractBearerToken("");
    } catch (err) {
      expect((err as OidcVerifyFailure).code).toBe("missing_authorization");
    }
  });

  it("string 以外 → missing_authorization", () => {
    try {
      extractBearerToken(123);
    } catch (err) {
      expect((err as OidcVerifyFailure).code).toBe("missing_authorization");
    }
  });

  it("Bearer prefix 不在 → invalid_authorization_format", () => {
    try {
      extractBearerToken("Basic abc.def");
    } catch (err) {
      expect((err as OidcVerifyFailure).code).toBe(
        "invalid_authorization_format",
      );
    }
  });

  it("Bearer のみ (token 不在) → invalid_authorization_format", () => {
    try {
      extractBearerToken("Bearer");
    } catch (err) {
      expect((err as OidcVerifyFailure).code).toBe(
        "invalid_authorization_format",
      );
    }
  });
});

describe("verifyOidcToken (pure)", () => {
  it("verifier が success を返せば caller を返す", async () => {
    const verifier = makeMockVerifier(async () => SUCCESS_CALLER);
    const result = await verifyOidcToken(
      "Bearer good.token",
      AUDIENCE,
      verifier,
    );
    expect(result).toEqual(SUCCESS_CALLER);
  });

  it("verifier が OidcVerifyFailure を throw → そのまま伝搬", async () => {
    const verifier = makeMockVerifier(async () => {
      throw new OidcVerifyFailure("audience_mismatch", "aud mismatch");
    });
    await expect(
      verifyOidcToken("Bearer bad.token", AUDIENCE, verifier),
    ).rejects.toThrow(OidcVerifyFailure);
  });

  it("header 形式違反は verifier 呼ばずに failure", async () => {
    const verifier = makeMockVerifier(vi.fn());
    await expect(
      verifyOidcToken(undefined, AUDIENCE, verifier),
    ).rejects.toThrow(/Authorization/);
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});

describe("requireValidOidcToken middleware (supertest)", () => {
  /** Express app with middleware + protected endpoint */
  function makeApp(verifier: OidcTokenVerifier) {
    const app = express();
    app.use(express.json());
    app.post(
      "/protected",
      requireValidOidcToken({ expectedAudience: AUDIENCE, verifier }),
      (req, res) => {
        const caller = (req as { oidcCaller?: VerifiedOidcCaller }).oidcCaller;
        res.json({ ok: true, caller });
      },
    );
    return app;
  }

  it("正常 token → 200 + req.oidcCaller がセットされる", async () => {
    const verifier = makeMockVerifier(async () => SUCCESS_CALLER);
    const app = makeApp(verifier);

    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer valid.token");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.caller).toEqual(SUCCESS_CALLER);
  });

  it("Authorization header なし → 401 + missing_authorization (ADR-010 形式)", async () => {
    const verifier = makeMockVerifier(vi.fn());
    const app = makeApp(verifier);

    const res = await request(app).post("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "missing_authorization",
      message: expect.stringMatching(/Authorization/),
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("audience_mismatch → 401 + audience_mismatch code", async () => {
    const verifier = makeMockVerifier(async () => {
      throw new OidcVerifyFailure(
        "audience_mismatch",
        "aud does not match",
      );
    });
    const app = makeApp(verifier);

    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer foo");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("audience_mismatch");
  });

  it("expired_token → 401 + expired_token code", async () => {
    const verifier = makeMockVerifier(async () => {
      throw new OidcVerifyFailure("expired_token", "expired");
    });
    const app = makeApp(verifier);

    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer foo");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("expired_token");
  });

  it("verifier が未知の例外を throw → 401 + invalid_token (汎用)", async () => {
    const verifier = makeMockVerifier(async () => {
      throw new Error("Unknown error inside verifier");
    });
    const app = makeApp(verifier);

    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer foo");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("Bearer prefix 不在 → 401 + invalid_authorization_format", async () => {
    const verifier = makeMockVerifier(vi.fn());
    const app = makeApp(verifier);

    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Basic abc");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_authorization_format");
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});
