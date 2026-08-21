import Provider from "oidc-provider";

/**
 * Phase 0 スパイク: devInteractions（oidc-provider 組み込みのダミー同意画面）で
 * OAuth ハンドシェイクの疎通のみを検証する。Firebase Google サインインへの委譲・
 * ドメイン検証は Phase 1 で本実装する（計画 planmode-whimsical-curry.md 参照）。
 * devInteractions は本番コネクタには絶対に接続しないこと。
 *
 * 既知の制約（Codex/code-reviewer両レビュー指摘、Phase 1で解消予定）: adapter/署名鍵を
 * 指定していないため oidc-provider 既定のインメモリ実装が使われる。DCRで登録した
 * クライアント・interactionセッション・発行済みトークンはすべてプロセスローカルにしか
 * 保持されない。Cloud Run が複数インスタンスにスケールする、またはインスタンスが
 * 再起動されると、認可コードフロー途中(/reg → /auth → /interaction の複数ホップ)で
 * 別インスタンスに着地した場合に失敗する。デプロイ時に `--max-instances=1` で単一
 * インスタンスに固定して緩和する(deploy.yml参照)。Firestore等の永続adapterへの
 * 置き換えはPhase 1のスコープ。
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

  // Cloud Run は TLS を外部(GFE)で終端し、コンテナへは平文HTTPで X-Forwarded-Proto等を
  // 付けて転送する。proxy=true にしないと oidc-provider が protocol を "http" と誤認し、
  // discovery documentやリダイレクトURLのスキームが本番で "https" にならない。
  provider.proxy = true;

  return provider;
}
