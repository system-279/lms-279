import Provider, { errors } from "oidc-provider";

/**
 * Phase 1a PR1: devInteractions（oidc-provider 組み込みのダミー同意画面）を廃止し、
 * 実 Firebase Google サインイン + 自前同意画面（src/interactions/）へ置き換えた
 * （計画 buzzing-rolling-whisper.md 参照）。findAccount は Firebase の uid を
 * そのまま accountId として扱う（MCP 認可サーバー自身はメールドメイン検証をしない
 * 方針。認可の実体は Phase 2 で quiz ツールが services/api を呼ぶ際の既存
 * allowed_emails チェックに委ねる）。
 *
 * 既知の制約（Phase 1a PR2 で解消予定）: adapter/署名鍵を指定していないため
 * oidc-provider 既定のインメモリ実装が使われる。DCRで登録したクライアント・
 * interactionセッション・発行済みトークンはすべてプロセスローカルにしか保持されない。
 * Cloud Run が複数インスタンスにスケールする、またはインスタンスが再起動されると、
 * 認可コードフロー途中(/reg → /auth → /interaction の複数ホップ)で別インスタンスに
 * 着地した場合に失敗する。デプロイ時に `--max-instances=1` で単一インスタンスに
 * 固定して緩和する(deploy.yml参照)。Firestore等の永続adapterへの置き換えは
 * Phase 1a PR2 のスコープ（PR1 を先にデプロイすることで、永続化が有効になる時点では
 * devInteractions 時代の偽装 Session が原理的に存在し得ない状態にしている）。
 */
export function createOidcProvider(issuerUrl: string): Provider {
  const resourceIdentifier = new URL(`${issuerUrl}/mcp`).href;

  const provider = new Provider(issuerUrl, {
    clients: [],
    findAccount: (_ctx, sub) => ({
      accountId: sub,
      claims: async () => ({ sub }),
    }),
    features: {
      devInteractions: { enabled: false },
      registration: {
        enabled: true,
        initialAccessToken: false,
        issueRegistrationAccessToken: true,
      },
      // MCPクライアントはRFC 8707に従い /auth に resource パラメータ(このMCPサーバーの
      // リソースURL)を必ず送る。oidc-provider は resourceIndicators 機能が(既定で)有効な
      // 場合、getResourceServerInfo の実装を要求する — 未指定だと常に invalid_target を
      // 投げるスタブが使われ、実クライアント接続で必ず失敗する(Phase 0で未検証のまま
      // リリースし、実クライアント接続で発覚)。
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo: (ctx, resourceIndicator) => {
          if (new URL(resourceIndicator).href !== resourceIdentifier) {
            throw new errors.InvalidTarget();
          }
          // MCPクライアントは scope パラメータを送らず resource のみで認可を要求してくる
          // (実クライアント接続で確認済み)。oidc-provider は要求 scope が空だと
          // op_scopes_missing/rs_scopes_missing のいずれも「missing なし」と判定し、
          // consent 後も grant に何も追加されないまま
          // 「authorization request resolved ... but no scope was granted」で
          // access_denied になる。resource 指定時は既定 scope を補い、consent→grant
          // 付与が機能するようにする（oidc-provider 自身が defaultResource で
          // params.resource を補完するのと同じパターン）。
          const { params } = ctx.oidc;
          if (params && !params.scope) {
            params.scope = "openid";
          }
          return { scope: "openid" };
        },
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
