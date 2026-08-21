import Provider from "oidc-provider";

/**
 * Phase 0 スパイク: devInteractions（oidc-provider 組み込みのダミー同意画面）で
 * OAuth ハンドシェイクの疎通のみを検証する。Firebase Google サインインへの委譲・
 * ドメイン検証は Phase 1 で本実装する（計画 planmode-whimsical-curry.md 参照）。
 * devInteractions は本番コネクタには絶対に接続しないこと。
 */
export function createOidcProvider(issuerUrl: string): Provider {
  const provider = new Provider(issuerUrl, {
    clients: [],
    features: {
      devInteractions: { enabled: true },
      registration: {
        enabled: true,
        initialAccessToken: false,
        issueRegistrationAccessToken: true,
      },
    },
    pkce: {
      required: () => true,
    },
    claims: {
      openid: ["sub"],
    },
  });

  return provider;
}
