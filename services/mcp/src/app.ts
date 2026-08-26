import { createServer, request as httpRequest } from "node:http";
import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import type { Express, NextFunction, Request, Response } from "express";
import type Provider from "oidc-provider";
import rateLimit from "express-rate-limit";
import { createOidcProvider, type OidcProviderOptions } from "./oidc.js";
import { createTokenVerifier } from "./token-verifier.js";
import { createMcpServer, type McpServerDeps } from "./mcp-server.js";
import { createInteractionRouter, type CredentialOptions } from "./interactions/router.js";
import type { FirebaseWebConfig } from "./interactions/views.js";
import { logger } from "./logger.js";

/**
 * oidc-provider は discovery document のエンドポイントURLを、固定した issuer 文字列
 * ではなく実際のリクエストの Host ヘッダ（と、proxy=true 時は X-Forwarded-Proto）から
 * 動的に構築する（実測で確認済み）。
 *
 * 一時サーバーは issuerUrl 自体ではなく実際にコンテナが listen するローカル bindPort
 * (Cloud Run が注入する PORT) に bind する — issuerUrl（本番では
 * `https://mcp-xxx.run.app`）の host:443 は Cloud Run コンテナ内には割り当てられて
 * おらず bind できない（Cloud Run は TLS 終端を外部で行い、コンテナは平文 HTTP で
 * 0.0.0.0:$PORT を listen するだけ）。ローカルでの自己フェッチ時に Host /
 * X-Forwarded-Proto ヘッダで issuerUrl を偽装することで、bindPort に関わらず
 * 常に issuerUrl 基準の絶対URLを含む discovery document を得る。
 *
 * 偽装には Node の低レベル `http.request` を使う（グローバル `fetch` = undici は
 * `Host` を forbidden header として黙って実際の接続先ホストで上書きするため、
 * ここでの Host 偽装が効かない。実機テストで発覚した既知の落とし穴）。
 */
async function fetchOidcMetadata(provider: Provider, issuerUrl: string, bindPort: number): Promise<OAuthMetadata> {
  const issuer = new URL(issuerUrl);
  const tempServer = createServer(provider.callback());
  await new Promise<void>((resolve, reject) => {
    tempServer.once("error", reject);
    tempServer.listen(bindPort, "127.0.0.1", resolve);
  });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: bindPort,
          path: "/.well-known/openid-configuration",
          method: "GET",
          headers: {
            host: issuer.host,
            "x-forwarded-proto": issuer.protocol.replace(":", ""),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`oidc discovery self-fetch failed: ${res.statusCode}`));
            res.resume();
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        }
      );
      req.once("error", reject);
      req.end();
    });
    return JSON.parse(body) as OAuthMetadata;
  } finally {
    await new Promise<void>((resolve, reject) => {
      tempServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export async function createApp(
  issuerUrl: string,
  bindPort: number,
  firebaseConfig: FirebaseWebConfig = {
    apiKey: process.env.FIREBASE_WEB_API_KEY ?? "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.FIREBASE_PROJECT_ID ?? "",
  },
  // Phase 1a PR2: Firestore adapter + Secret Manager 署名鍵を注入する場合に渡す。
  // 省略時は現行どおり oidc-provider 既定のインメモリ実装(既存テストとの後方互換)。
  storageOptions: OidcProviderOptions = {},
  // Phase 1b-1: Firebaseリフレッシュトークンの暗号化永続化に使うstore/keyring。
  // 省略時はサインイン時の永続化をスキップする(既存テストとの後方互換)。
  credentialOptions?: CredentialOptions,
  // Phase 2a: quizツール（list_courses/list_lessons/get_quiz）が依存するサービス群。
  // 省略時は ping のみ登録する(既存テストとの後方互換)。
  mcpServerDeps?: McpServerDeps
): Promise<{ app: Express; provider: Provider }> {
  const provider = createOidcProvider(issuerUrl, storageOptions);
  const oauthMetadata = await fetchOidcMetadata(provider, issuerUrl, bindPort);

  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [new URL(issuerUrl).hostname] });
  // Cloud Run等リバースプロキシ経由時にクライアントIPを正しく取得
  // (services/api/src/index.ts:41-42 と同一パターン。express-rate-limit v8 は
  // これが無いとプロキシ経由リクエストで検証エラーを投げる)。
  app.set("trust proxy", 1);
  const resourceServerUrl = new URL(`${issuerUrl}/mcp`);

  // DCR (/reg) は initialAccessToken:false で誰でもクライアント登録できるため、
  // 最低限のレート制限を掛ける(計画ファイル「DCR登録へのレート制限」節。
  // 濫用対策の本実装はPhase 1bのスコープ)。vitest は NODE_ENV=test を既定注入する
  // ため(公式Vite/Vitest挙動、実測確認済み)、テストスイート内の多数のDCR登録が
  // 誤って本番想定のレート制限に引っかからないようskipする。
  const registrationLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: {
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" },
    },
  });
  app.use("/reg", registrationLimiter);

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      resourceName: "LMS Quiz MCP (Phase 0 spike)",
    })
  );

  const tokenVerifier = createTokenVerifier(provider);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  app.post(
    "/mcp",
    requireBearerAuth({ verifier: tokenVerifier, resourceMetadataUrl }),
    async (req, res) => {
      // リクエストごとに McpServer + transport を新規生成する。単一の McpServer を
      // 使い回して複数リクエストで connect() すると、Cloud Run 上の同時リクエストで
      // アクティブトランスポートが奪い合いになりレスポンスが取り違わる/消失しうる
      // (Codex review PR #636 指摘)。ping 程度の軽量サーバーなのでコストは無視できる。
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = createMcpServer(mcpServerDeps);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
  );

  // Phase 1a PR1: devInteractions を廃止した実 Firebase サインイン + 同意画面。
  // provider.callback()（下記 catch-all）より必ず前に登録する — 一致しなければ
  // catch-all の oidc-provider 側ルーティングに落ちてしまう。
  app.use(createInteractionRouter(provider, firebaseConfig, credentialOptions));

  // OAuth AS の全エンドポイント (/auth, /token, /reg, /jwks, /.well-known/openid-configuration 等)。
  // 上記の Express 固有ルートに一致しないリクエストのみここに落ちる。
  // provider.callback() は Koa ハンドラ(arity 2)のため next() を一切呼ばず、
  // 内部で自己完結してエラー処理する。よって下記エラーハンドラは
  // createInteractionRouter 等の Express 固有ルートが next(err) した場合のみ発火する。
  app.use(provider.callback());

  // 未捕捉エラーのフォールバック。NODE_ENV=production 未設定でも Express 既定の
  // finalhandler が err.stack をレスポンスに含めないよう、ここで必ず遮断する
  // (--allow-unauthenticated な本サービスでは誰でも閲覧できてしまうため。
  // pr-review-toolkit 2系統のセカンドオピニオンが独立に指摘、実ソースで検証済み)。
  // 4引数シグネチャが Express にエラーハンドラと認識される要件のため、
  // 未使用引数も省略しない。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled request error", { error: err });
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ error: "internal_error" });
  });

  return { app, provider };
}
