import { createServer } from "node:http";
import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import type { Express } from "express";
import type Provider from "oidc-provider";
import { createOidcProvider } from "./oidc.js";
import { createTokenVerifier } from "./token-verifier.js";
import { createMcpServer } from "./mcp-server.js";

/**
 * oidc-provider は discovery document のエンドポイントURLを、固定した issuer 文字列
 * ではなく実際のリクエストの Host ヘッダから動的に構築する（実測で確認済み: エフェメラル
 * ポートで自己フェッチすると、そのエフェメラルポートがメタデータに漏れ出す）。
 * そのため一時サーバーは issuerUrl と同じホスト・ポートに bind してから自己フェッチし、
 * 直後に close して本体サーバーへ明け渡す（同時 bind はしない、逐次的な立ち上げ）。
 * 本番(Cloud Run)では実際のリクエストが正しい Host ヘッダを伴うため、この自己フェッチの
 * トリックは Phase 0/ローカル検証専用の簡易実装であり、Phase 1 で見直しの余地がある。
 */
async function fetchOidcMetadata(provider: Provider, issuerUrl: string): Promise<OAuthMetadata> {
  const issuer = new URL(issuerUrl);
  const port = issuer.port ? Number(issuer.port) : issuer.protocol === "https:" ? 443 : 80;
  const tempServer = createServer(provider.callback());
  await new Promise<void>((resolve, reject) => {
    tempServer.once("error", reject);
    tempServer.listen(port, issuer.hostname, resolve);
  });
  try {
    const res = await fetch(new URL("/.well-known/openid-configuration", issuerUrl));
    if (!res.ok) {
      throw new Error(`oidc discovery self-fetch failed: ${res.status}`);
    }
    return (await res.json()) as OAuthMetadata;
  } finally {
    await new Promise<void>((resolve, reject) => {
      tempServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export async function createApp(issuerUrl: string): Promise<{ app: Express; provider: Provider }> {
  const provider = createOidcProvider(issuerUrl);
  const oauthMetadata = await fetchOidcMetadata(provider, issuerUrl);

  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [new URL(issuerUrl).hostname] });
  const resourceServerUrl = new URL(`${issuerUrl}/mcp`);

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      resourceName: "LMS Quiz MCP (Phase 0 spike)",
    })
  );

  const tokenVerifier = createTokenVerifier(provider);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  const mcpServer = createMcpServer();

  app.post(
    "/mcp",
    requireBearerAuth({ verifier: tokenVerifier, resourceMetadataUrl }),
    async (req, res) => {
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
  );

  // Phase 0: devInteractions (oidc-provider 組み込みのダミー同意画面) を含む
  // OAuth AS の全エンドポイント (/auth, /token, /reg, /jwks, /.well-known/openid-configuration 等)。
  // 上記の Express 固有ルートに一致しないリクエストのみここに落ちる。
  app.use(provider.callback());

  return { app, provider };
}
