import Provider, { errors, type Adapter, type AdapterFactory, type JWKS } from "oidc-provider";

/**
 * Phase 1a PR1: devInteractions（oidc-provider 組み込みのダミー同意画面）を廃止し、
 * 実 Firebase Google サインイン + 自前同意画面（src/interactions/）へ置き換えた
 * （計画 buzzing-rolling-whisper.md 参照）。findAccount は Firebase の uid を
 * そのまま accountId として扱う（MCP 認可サーバー自身はメールドメイン検証をしない
 * 方針。認可の実体は Phase 2 で quiz ツールが services/api を呼ぶ際の既存
 * allowed_emails チェックに委ねる）。
 *
 * Phase 1a PR2: adapter/jwks/cookieKeys を省略すると oidc-provider 既定のインメモリ実装
 * (`new Provider()` 呼び出しごとに独立したクロージャstore、`node_modules/oidc-provider/
 * lib/helpers/initialize_adapter.js:14` で確認済み)と、パッケージ同梱の固定開発用秘密鍵
 * (`jwks` 未指定時は `structuredClone(DEV_KEYSTORE)`、全 oidc-provider インストール共通の
 * 既知の秘密鍵。`initialize_keystore.js:283` で確認済み)が使われる。本番では
 * `MCP_STORAGE=firestore` 時に index.ts から Firestore adapter + Secret Manager 由来の
 * 署名鍵が注入される（services/mcp/src/storage/firestore-adapter.ts、signing-keys.ts）。
 */
export interface OidcProviderOptions {
  adapter?: AdapterFactory | (new (name: string) => Adapter);
  jwks?: JWKS;
  cookieKeys?: string[];
}

/**
 * Session/Grant/RefreshToken の既定TTL(oidc-providerの既定値、全て14日)を24時間へ短縮する。
 *
 * Phase 2a: quizツールがcredential-service.ts（Phase 1b-1で永続化したFirebase
 * リフレッシュトークン）に依存するようになったため、その資格情報が何らかの理由で
 * 失われた場合（デコード不能・Firestore書き込み中断等）の影響が「起きても実害なし」
 * から「実際に起きうる障害」に格上げされた（codex review P1指摘、2026-08-23）。
 *
 * 資格情報喪失時に返す CredentialNotFoundError の「再認証してください」という
 * 案内は、oidc-providerのセッションCookieが有効な間はブラウザで再接続しても
 * Firebaseログイン自体がスキップされ実質的に自己回復できないことが実機確認で
 * 判明した（既存Sessionがあると"login" promptがスキップされる仕様）。既定の
 * Session/Grant/RefreshToken TTL(14日)のままだと最悪14日間ツールが使えない。
 * 24時間へ短縮することで、この「自己回復できない」ウィンドウの上限を大幅に
 * 縮める（根治ではなく緩和策 — 明示的なreconnectフローの実装は将来検討）。
 */
const SHORT_LIVED_TTL_SECONDS = 24 * 60 * 60;

export function createOidcProvider(issuerUrl: string, options: OidcProviderOptions = {}): Provider {
  const resourceIdentifier = new URL(`${issuerUrl}/mcp`).href;

  const provider = new Provider(issuerUrl, {
    clients: [],
    ...(options.adapter ? { adapter: options.adapter } : {}),
    ...(options.jwks ? { jwks: options.jwks } : {}),
    ...(options.cookieKeys ? { cookies: { keys: options.cookieKeys } } : {}),
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
    ttl: {
      Session: () => SHORT_LIVED_TTL_SECONDS,
      Grant: () => SHORT_LIVED_TTL_SECONDS,
      // ローテーション時は oidc-provider 既定と同じくローテート元の残余TTLを引き継ぐ
      // (非スライディング。ローテーションのたびに寿命が延びる挙動を避けるための
      // 既定の設計であり、ここでは基準値だけを短縮する)。
      RefreshToken: (ctx, token, client) => {
        if (
          ctx?.oidc?.entities.RotatedRefreshToken &&
          client.applicationType === "web" &&
          client.clientAuthMethod === "none" &&
          !token.isSenderConstrained()
        ) {
          return ctx.oidc.entities.RotatedRefreshToken.remainingTTL;
        }
        return SHORT_LIVED_TTL_SECONDS;
      },
    },
  });

  // Cloud Run は TLS を外部(GFE)で終端し、コンテナへは平文HTTPで X-Forwarded-Proto等を
  // 付けて転送する。proxy=true にしないと oidc-provider が protocol を "http" と誤認し、
  // discovery documentやリダイレクトURLのスキームが本番で "https" にならない。
  provider.proxy = true;

  return provider;
}
