import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app.js";

const ISSUER_URL = "http://127.0.0.1:8082";

/**
 * 簡易 Cookie jar。Set-Cookie の属性(Path/HttpOnly/SameSite等)を除いた
 * name=value のみを保持し、同名は上書きする。Cookie リクエストヘッダは
 * "name=value; name2=value2" 形式でなければならず、Set-Cookie の文字列を
 * そのまま連結して送ると（属性込みで壊れるため）サーバー側の Cookie 解析に失敗する。
 */
function mergeCookies(jar: Map<string, string>, setCookieHeader: string[] | undefined): Map<string, string> {
  for (const raw of setCookieHeader ?? []) {
    const pair = raw.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

describe("Phase 0: OAuth ハンドシェイク疎通", () => {
  let app: Express;

  beforeAll(async () => {
    ({ app } = await createApp(ISSUER_URL));
  });

  it("RFC 9728 保護リソースメタデータを配信する", async () => {
    const res = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(`${ISSUER_URL}/mcp`);
    expect(res.body.authorization_servers).toContain(ISSUER_URL);
  });

  it("RFC 8414 認可サーバーメタデータを配信し、S256 PKCE をサポートする", async () => {
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(ISSUER_URL);
    expect(res.body.registration_endpoint).toBeDefined();
    expect(res.body.code_challenge_methods_supported).toContain("S256");
  });

  it("トークンなしで /mcp を叩くと 401 + WWW-Authenticate(resource_metadata付き) を返す", async () => {
    const res = await request(app).post("/mcp").send({});
    expect(res.status).toBe(401);
    const challenge = res.headers["www-authenticate"];
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata=");
  });

  it("DCR(動的クライアント登録)でクライアントを登録できる", async () => {
    const res = await request(app)
      .post("/reg")
      .set("Content-Type", "application/json")
      .send({
        redirect_uris: ["http://localhost:0/callback", "http://127.0.0.1:0/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeDefined();
    expect(res.body.redirect_uris).toContain("http://localhost:0/callback");
  });

  it("PKCE付き認可コードフローでトークンを取得し、それを使って ping ツールを呼べる（devInteractionsのダミー同意画面経由）", async () => {
    // 1. DCR でクライアント登録（token_endpoint_auth_method: none = 公開クライアント）
    const reg = await request(app)
      .post("/reg")
      .set("Content-Type", "application/json")
      .send({
        redirect_uris: ["http://localhost:1234/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;

    // 2. PKCE code_verifier/challenge を生成（S256）
    const crypto = await import("node:crypto");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    // 3. /auth へ認可リクエスト → devInteractions のダミー同意画面へリダイレクトされる
    const authRes = await request(app).get("/auth").query({
      client_id: clientId,
      redirect_uri: "http://localhost:1234/callback",
      response_type: "code",
      scope: "openid",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    expect([302, 303]).toContain(authRes.status);

    // devInteractions は login → consent と複数プロンプトを踏みうる。
    // /interaction/:uid のGETで得たフォーム内容(name="login" input の有無)でプロンプト種別を判定し、
    // /auth/:uid (resume) → 次の /interaction/:uid → ... と、クライアントの redirect_uri に
    // 到達するまで追従する。GET/POST とも同一パス /interaction/:uid（フォームの hidden field
    // `prompt` で分岐、oidc-provider lib/actions/interaction.js 実装に準拠）。
    let jar = mergeCookies(new Map(), authRes.headers["set-cookie"] as unknown as string[]);
    let location = authRes.headers.location as string;
    let code: string | null = null;

    for (let hop = 0; hop < 6 && !code; hop += 1) {
      const path = new URL(location, ISSUER_URL).pathname + new URL(location, ISSUER_URL).search;

      if (path.startsWith("/interaction/")) {
        const uid = path.slice("/interaction/".length).split("/")[0];
        const page = await request(app).get(path).set("Cookie", cookieHeader(jar));
        expect(page.status).toBe(200);
        jar = mergeCookies(jar, page.headers["set-cookie"] as unknown as string[]);
        const isLoginPrompt = page.text.includes('name="login"');
        const submitRes = await request(app)
          .post(`/interaction/${uid}`)
          .set("Cookie", cookieHeader(jar))
          .type("form")
          .send(
            isLoginPrompt
              ? { prompt: "login", login: "phase0-test-account", password: "any" }
              : { prompt: "consent" }
          );
        expect([302, 303]).toContain(submitRes.status);
        location = submitRes.headers.location as string;
        jar = mergeCookies(jar, submitRes.headers["set-cookie"] as unknown as string[]);
        continue;
      }

      const resumeRes = await request(app).get(path).set("Cookie", cookieHeader(jar));
      expect([302, 303]).toContain(resumeRes.status);
      const nextLocation = resumeRes.headers.location as string;
      const nextUrl = new URL(nextLocation, ISSUER_URL);
      if (nextUrl.origin === "http://localhost:1234") {
        code = nextUrl.searchParams.get("code");
        break;
      }
      location = nextLocation;
      jar = mergeCookies(jar, resumeRes.headers["set-cookie"] as unknown as string[]);
    }

    expect(code).toBeTruthy();

    // 7. /token で認可コードをアクセストークンに交換（PKCE code_verifier検証込み）
    const tokenRes = await request(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:1234/callback",
        client_id: clientId,
        code_verifier: codeVerifier,
      });
    expect(tokenRes.status).toBe(200);
    const accessToken = tokenRes.body.access_token as string;
    expect(accessToken).toBeTruthy();

    // 8. 取得したアクセストークンで /mcp の ping ツールを呼ぶ
    const mcpRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      });
    expect(mcpRes.status).toBe(200);
  });

  it("ドメイン外/未検証トークンで /mcp を叩くと 401 になる", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(res.status).toBe(401);
  });
});
