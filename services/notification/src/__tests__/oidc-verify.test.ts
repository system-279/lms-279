/**
 * oidc-verify の単体 + Integration テスト。
 * services/api/src/services/dispatch/__tests__/oidc-verify.test.ts をベースに、
 * caller email allowlist 検証（本サービス独自の追加要件）のテストを加えている。
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

const AUDIENCE = "https://notification-xyz.a.run.app/internal/error-alert";

const SUCCESS_CALLER: VerifiedOidcCaller = {
  email: "ops-pubsub@lms-279.iam.gserviceaccount.com",
  subject: "1234567890",
  audience: AUDIENCE,
};

function makeMockVerifier(impl: OidcTokenVerifier["verify"]): OidcTokenVerifier {
  return { verify: impl };
}

describe("extractBearerToken", () => {
  it("正常な Bearer header → token 抽出", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("undefined header → missing_authorization", () => {
    // try/catch without expect.assertions は catch に入らない回帰があっても
    // 緑のままPASSしてしまうため、toThrow で確実に例外送出を検証する
    // （pr-review-toolkit pr-test-analyzer 指摘）。
    expect(() => extractBearerToken(undefined)).toThrow(OidcVerifyFailure);
    try {
      extractBearerToken(undefined);
      expect.unreachable("例外が投げられるはず");
    } catch (err) {
      expect((err as OidcVerifyFailure).code).toBe("missing_authorization");
    }
  });

  it("Bearer prefix 不在 → invalid_authorization_format", () => {
    expect(() => extractBearerToken("Basic abc.def")).toThrow(OidcVerifyFailure);
    try {
      extractBearerToken("Basic abc.def");
    } catch (err) {
      expect((err as OidcVerifyFailure).code).toBe("invalid_authorization_format");
    }
  });
});

describe("verifyOidcToken (pure)", () => {
  it("verifier が success を返せば caller を返す", async () => {
    const verifier = makeMockVerifier(async () => SUCCESS_CALLER);
    const result = await verifyOidcToken("Bearer good.token", AUDIENCE, verifier);
    expect(result).toEqual(SUCCESS_CALLER);
  });

  it("header 形式違反は verifier 呼ばずに failure", async () => {
    const verifier = makeMockVerifier(vi.fn());
    await expect(verifyOidcToken(undefined, AUDIENCE, verifier)).rejects.toThrow(/Authorization/);
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});

describe("requireValidOidcToken middleware (supertest)", () => {
  function makeApp(verifier: OidcTokenVerifier, allowedCallerEmails: string[]) {
    const app = express();
    app.use(express.json());
    app.post(
      "/protected",
      requireValidOidcToken({ expectedAudience: AUDIENCE, allowedCallerEmails, verifier }),
      (req, res) => {
        const caller = (req as { oidcCaller?: VerifiedOidcCaller }).oidcCaller;
        res.json({ ok: true, caller });
      }
    );
    return app;
  }

  it("正常 token + allowlist に含まれる email → 200", async () => {
    const verifier = makeMockVerifier(async () => SUCCESS_CALLER);
    const app = makeApp(verifier, [SUCCESS_CALLER.email]);

    const res = await request(app).post("/protected").set("Authorization", "Bearer valid.token");

    expect(res.status).toBe(200);
    expect(res.body.caller).toEqual(SUCCESS_CALLER);
  });

  it("token は正常だが allowlist に含まれない email → 401 caller_not_allowed", async () => {
    const verifier = makeMockVerifier(async () => SUCCESS_CALLER);
    const app = makeApp(verifier, ["other-sa@lms-279.iam.gserviceaccount.com"]);

    const res = await request(app).post("/protected").set("Authorization", "Bearer valid.token");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("caller_not_allowed");
  });

  it("allowlistが空配列 → 誰も許可しない（設定漏れによるオープン化を防ぐ）", async () => {
    const verifier = makeMockVerifier(async () => SUCCESS_CALLER);
    const app = makeApp(verifier, []);

    const res = await request(app).post("/protected").set("Authorization", "Bearer valid.token");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("caller_not_allowed");
  });

  it("Authorization header なし → 401 missing_authorization", async () => {
    const verifier = makeMockVerifier(vi.fn());
    const app = makeApp(verifier, [SUCCESS_CALLER.email]);

    const res = await request(app).post("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("audience_mismatch → 401 audience_mismatch", async () => {
    const verifier = makeMockVerifier(async () => {
      throw new OidcVerifyFailure("audience_mismatch", "aud does not match");
    });
    const app = makeApp(verifier, [SUCCESS_CALLER.email]);

    const res = await request(app).post("/protected").set("Authorization", "Bearer foo");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("audience_mismatch");
  });

  it("verifierが未知の例外をthrow → 401 invalid_token（汎用）", async () => {
    const verifier = makeMockVerifier(async () => {
      throw new Error("Unknown error inside verifier");
    });
    const app = makeApp(verifier, [SUCCESS_CALLER.email]);

    const res = await request(app).post("/protected").set("Authorization", "Bearer foo");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });
});
