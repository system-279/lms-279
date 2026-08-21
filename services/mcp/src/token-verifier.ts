import type Provider from "oidc-provider";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";

export function createTokenVerifier(provider: Provider): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const accessToken = await provider.AccessToken.find(token);
      if (!accessToken || !accessToken.isValid) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid or expired access token");
      }
      return {
        token,
        clientId: accessToken.clientId ?? "unknown",
        scopes: [...accessToken.scopes],
        expiresAt: accessToken.exp,
        extra: { accountId: accessToken.accountId },
      };
    },
  };
}
