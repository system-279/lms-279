import { createServer, request as httpRequest } from "node:http";
import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import type { Express } from "express";
import type Provider from "oidc-provider";
import rateLimit from "express-rate-limit";
import { createOidcProvider } from "./oidc.js";
import { createTokenVerifier } from "./token-verifier.js";
import { createMcpServer } from "./mcp-server.js";
import { createInteractionRouter } from "./interactions/router.js";
import type { FirebaseWebConfig } from "./interactions/views.js";

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
  }
): Promise<{ app: Express; provider: Provider }> {
  const provider = createOidcProvider(issuerUrl);
  const oauthMetadata = await fetchOidcMetadata(provider, issuerUrl, bindPort);

  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [new URL(issuerUrl).hostname] });
  // Cloud Run等リバースプロキシ経由時にクライアントIPを正しく取得
  // (services/api/src/index.ts:41-42 と同一パターン。express-rate-limit v8 は
  // これが無いとプロキシ経由リクエストで検証エラーを投げる)。
  app.set("trust proxy", 1);
  const resourceServerUrl = new URL(`${issuerUrl}/mcp`);

  // DCR (/reg) は initialAccessToken:false で誰でもクライアント登録できるため、
  // 最低限のレート制限を掛ける(計画ファイル「DCR登録へのレート制限」節。
  // 濫用対策の本実装はPhase 1bのスコープ)。
  const registrationLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
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
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
  );

  // Phase 1a PR1: devInteractions を廃止した実 Firebase サインイン + 同意画面。
  // provider.callback()（下記 catch-all）より必ず前に登録する — 一致しなければ
  // catch-all の oidc-provider 側ルーティングに落ちてしまう。
  app.use(createInteractionRouter(provider, firebaseConfig));

  // OAuth AS の全エンドポイント (/auth, /token, /reg, /jwks, /.well-known/openid-configuration 等)。
  // 上記の Express 固有ルートに一致しないリクエストのみここに落ちる。
  app.use(provider.callback());

  return { app, provider };
}
