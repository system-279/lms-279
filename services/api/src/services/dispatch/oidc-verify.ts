/**
 * Cloud Scheduler から受け取る OIDC ID Token を検証する pure 関数 + Express middleware。
 *
 * 設計仕様書 §3.1 / NFR-2 / AC-30 に対応。
 *
 * 認証フロー:
 *   1. Cloud Scheduler が internal endpoint を呼び出す際、Service Account の
 *      OIDC ID Token を `Authorization: Bearer <jwt>` として送る
 *   2. 本 module が JWT 署名 (Google 公開鍵で verify) + audience の一致を確認
 *   3. caller (Cloud Scheduler の SA email) を req に attach
 *
 * Audience 検証:
 *   Cloud Scheduler 設定で audience = endpoint URL を指定する想定。OIDC ID Token の
 *   aud claim が configured DISPATCH_INTERNAL_AUDIENCE env と一致しなければ
 *   401 で reject (token reuse / cross-environment attack 対策)。
 */

import type { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";

/** OIDC 検証結果。caller の subject (Service Account email) を含む */
export interface VerifiedOidcCaller {
  /** Service Account email (e.g., dxcollege-scheduler@lms-279.iam.gserviceaccount.com) */
  email: string;
  /** JWT subject (通常は SA の unique ID) */
  subject: string;
  /** 検証成功時の audience (env と一致したもの) */
  audience: string;
}

export type OidcVerifyError =
  | "missing_authorization"
  | "invalid_authorization_format"
  | "invalid_token"
  | "audience_mismatch"
  | "expired_token";

export class OidcVerifyFailure extends Error {
  constructor(
    public readonly code: OidcVerifyError,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OidcVerifyFailure";
  }
}

/** Authorization header から Bearer token を抽出 */
export function extractBearerToken(headerValue: unknown): string {
  if (typeof headerValue !== "string" || headerValue.length === 0) {
    throw new OidcVerifyFailure(
      "missing_authorization",
      "Authorization header is missing",
    );
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  if (!match) {
    throw new OidcVerifyFailure(
      "invalid_authorization_format",
      "Authorization header must be in 'Bearer <token>' format",
    );
  }
  return match[1].trim();
}

/** Token verifier 抽象。本番は google-auth-library、テストは mock */
export interface OidcTokenVerifier {
  verify(
    idToken: string,
    expectedAudience: string,
  ): Promise<VerifiedOidcCaller>;
}

/** 本番用 OIDC verifier (google-auth-library 利用) */
export class GoogleOidcTokenVerifier implements OidcTokenVerifier {
  private client = new OAuth2Client();

  async verify(
    idToken: string,
    expectedAudience: string,
  ): Promise<VerifiedOidcCaller> {
    let ticket;
    try {
      ticket = await this.client.verifyIdToken({
        idToken,
        audience: expectedAudience,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/expired/i.test(msg)) {
        throw new OidcVerifyFailure("expired_token", msg, { cause: err });
      }
      throw new OidcVerifyFailure("invalid_token", msg, { cause: err });
    }
    const payload = ticket.getPayload();
    if (!payload) {
      throw new OidcVerifyFailure("invalid_token", "OIDC token has no payload");
    }
    if (payload.aud !== expectedAudience) {
      throw new OidcVerifyFailure(
        "audience_mismatch",
        `Expected audience '${expectedAudience}' but got '${String(payload.aud ?? "")}'`,
      );
    }
    return {
      email: typeof payload.email === "string" ? payload.email : "",
      subject: typeof payload.sub === "string" ? payload.sub : "",
      audience: expectedAudience,
    };
  }
}

/** Authorization header の Bearer token を verify して caller を返す */
export async function verifyOidcToken(
  headerValue: unknown,
  expectedAudience: string,
  verifier: OidcTokenVerifier,
): Promise<VerifiedOidcCaller> {
  const token = extractBearerToken(headerValue);
  return verifier.verify(token, expectedAudience);
}

/** VerifiedOidcCaller を request に attach する augmentation */
export interface RequestWithOidcCaller extends Request {
  oidcCaller?: VerifiedOidcCaller;
}

/**
 * Express middleware factory。expectedAudience / verifier を closure で固定。
 * 失敗時は 401 + ADR-010 フラットエラー形式 `{ error, message }` を返す。
 */
export function requireValidOidcToken(opts: {
  expectedAudience: string;
  verifier: OidcTokenVerifier;
}): (req: RequestWithOidcCaller, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void (async () => {
      try {
        const caller = await verifyOidcToken(
          req.headers.authorization,
          opts.expectedAudience,
          opts.verifier,
        );
        req.oidcCaller = caller;
        next();
      } catch (err) {
        if (err instanceof OidcVerifyFailure) {
          res.status(401).json({
            error: err.code,
            message: err.message,
          });
          return;
        }
        res.status(401).json({
          error: "invalid_token",
          message: "OIDC token verification failed",
        });
      }
    })();
  };
}
