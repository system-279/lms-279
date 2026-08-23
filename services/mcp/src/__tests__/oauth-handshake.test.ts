import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import * as crypto from "node:crypto";
import { createFirestoreAdapterFactory } from "../storage/firestore-adapter.js";
import { createFakeFirestore } from "../storage/__tests__/fake-firestore.js";
import { createCredentialStore } from "../storage/credential-store.js";
import { decryptWithKeyring } from "../crypto/aes-gcm.js";
import { createCredentialService } from "../credential-service.js";

const mockVerifyIdToken = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));

vi.mock("firebase-admin/app", () => ({
  getApps: () => [{ name: "[DEFAULT]" }],
  initializeApp: vi.fn(),
}));

const { createApp } = await import("../app.js");

const ISSUER_URL = "http://127.0.0.1:8082";
const BIND_PORT = 8082;

/**
 * Google プロバイダ + 検証済みメールの標準 decodedToken を生成するヘルパー。
 * services/api/src/middleware/__tests__/super-admin-firebase.test.ts と同じパターン。
 */
function makeDecodedToken(overrides: Record<string, unknown> = {}) {
  return {
    uid: "test-firebase-uid",
    email: "quiz-editor@example.com",
    email_verified: true,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  };
}

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

/**
 * DCR でクライアント登録し、/auth を叩いて最初の interaction（常に login prompt。
 * フレッシュな cookie jar なので有効なセッションが存在しない）まで遷移する。
 * ログイン拒否系のテストと、正常系ヘルパー(obtainAuthorizationCode)の両方から使う。
 */
async function startAuthorization(
  app: Express,
  redirectUri: string,
  codeChallenge: string,
  resource: string,
  scope?: string,
  grantTypes: string[] = ["authorization_code"]
): Promise<{ clientId: string; jar: Map<string, string>; uid: string }> {
  const reg = await request(app)
    .post("/reg")
    .set("Content-Type", "application/json")
    .send({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
      response_types: ["code"],
    });
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id as string;

  // 実クライアント(Claude等)は RFC 8707 に従い resource パラメータを送る。
  // これを省略すると Phase 0 で発覚した invalid_target 回帰を検知できない。
  // また実クライアントは scope パラメータを一切送らない(resource のみ)ため、
  // scope 未指定でも呼べるようにする(invalid_client/access_denied 回帰の再現用)。
  const query: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    resource,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  if (scope !== undefined) {
    query.scope = scope;
  }
  const authRes = await request(app).get("/auth").query(query);
  expect([302, 303]).toContain(authRes.status);

  let jar = mergeCookies(new Map(), authRes.headers["set-cookie"] as unknown as string[]);
  const location = authRes.headers.location as string;
  const url = new URL(location, ISSUER_URL);
  expect(url.pathname.startsWith("/interaction/")).toBe(true);
  const uid = url.pathname.slice("/interaction/".length).split("/")[0];

  const page = await request(app).get(url.pathname + url.search).set("Cookie", cookieHeader(jar));
  expect(page.status).toBe(200);
  jar = mergeCookies(jar, page.headers["set-cookie"] as unknown as string[]);
  expect(page.text).toContain('id="signin"'); // 常に login prompt であることの前提確認

  return { clientId, jar, uid };
}

/**
 * 実 Firebase Google サインイン（verifyIdTokenをモック）→ 同意画面 の一連を追従して、
 * PKCE付き認可コードを取得するまでを行う。
 */
async function obtainAuthorizationCode(
  app: Express,
  redirectUri: string,
  codeChallenge: string,
  resource: string,
  scope?: string,
  grantTypes: string[] = ["authorization_code"],
  refreshToken?: string
): Promise<{ clientId: string; code: string }> {
  const { clientId, jar: startJar, uid: loginUid } = await startAuthorization(
    app,
    redirectUri,
    codeChallenge,
    resource,
    scope,
    grantTypes
  );
  let jar = startJar;

  mockVerifyIdToken.mockResolvedValueOnce(makeDecodedToken());
  const callbackRes = await request(app)
    .post(`/interaction/${loginUid}/firebase-callback`)
    .set("Cookie", cookieHeader(jar))
    .send(refreshToken === undefined ? { idToken: "fake-id-token" } : { idToken: "fake-id-token", refreshToken });
  expect(callbackRes.status).toBe(200);
  jar = mergeCookies(jar, callbackRes.headers["set-cookie"] as unknown as string[]);
  let location = callbackRes.body.redirectTo as string;

  let code: string | null = null;
  const redirectOrigin = new URL(redirectUri).origin;

  for (let hop = 0; hop < 8 && !code; hop += 1) {
    const url = new URL(location, ISSUER_URL);
    const path = url.pathname + url.search;

    if (url.pathname.startsWith("/interaction/")) {
      const uid = url.pathname.slice("/interaction/".length).split("/")[0];
      const page = await request(app).get(path).set("Cookie", cookieHeader(jar));
      expect(page.status).toBe(200);
      jar = mergeCookies(jar, page.headers["set-cookie"] as unknown as string[]);
      expect(page.text).toContain('id="approve"'); // login後は常に consent prompt の前提確認

      const confirmRes = await request(app)
        .post(`/interaction/${uid}/confirm`)
        .set("Cookie", cookieHeader(jar))
        .send({});
      expect(confirmRes.status).toBe(200);
      jar = mergeCookies(jar, confirmRes.headers["set-cookie"] as unknown as string[]);
      location = confirmRes.body.redirectTo as string;
      continue;
    }

    const resumeRes = await request(app).get(path).set("Cookie", cookieHeader(jar));
    expect([302, 303]).toContain(resumeRes.status);
    const nextLocation = resumeRes.headers.location as string;
    const nextUrl = new URL(nextLocation, ISSUER_URL);
    if (nextUrl.origin === redirectOrigin) {
      code = nextUrl.searchParams.get("code");
      break;
    }
    location = nextLocation;
    jar = mergeCookies(jar, resumeRes.headers["set-cookie"] as unknown as string[]);
  }

  expect(code).toBeTruthy();
  return { clientId, code: code as string };
}

function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

describe("Phase 1a PR1: OAuth ハンドシェイク疎通（実Firebaseサインイン経由）", () => {
  let app: Express;

  beforeAll(async () => {
    ({ app } = await createApp(ISSUER_URL, BIND_PORT));
  });

  beforeEach(() => {
    mockVerifyIdToken.mockReset();
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

  it("PKCE付き認可コードフローでトークンを取得し、それを使って ping ツールを呼べる（実Firebaseサインイン経由）", async () => {
    const redirectUri = "http://localhost:1234/callback";
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const { clientId, code } = await obtainAuthorizationCode(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

    const tokenRes = await request(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      });
    expect(tokenRes.status).toBe(200);
    const accessToken = tokenRes.body.access_token as string;
    expect(accessToken).toBeTruthy();

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

  it("実クライアント同様 scope パラメータを省略しても(resourceのみで)認可コードとトークンを取得できる", async () => {
    // 実クライアント(Claude)は /auth に scope を一切送らず resource のみ送る。
    // oidc-provider は要求 scope が空だと consent 後も grant に何も追加されず
    // 「no scope was granted」で access_denied になる回帰があった(実クライアント接続で発覚、PR #639)。
    const redirectUri = "http://localhost:1234/callback";
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const { clientId, code } = await obtainAuthorizationCode(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`);

    const tokenRes = await request(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      });
    expect(tokenRes.status).toBe(200);
    const accessToken = tokenRes.body.access_token as string;
    expect(accessToken).toBeTruthy();

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

  it("PKCE code_verifier が一致しない場合、/token がトークン発行を拒否する", async () => {
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();
    const { codeVerifier: wrongVerifier } = generatePkcePair(); // 別ペアの verifier(不一致)
    const { clientId, code } = await obtainAuthorizationCode(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

    const tokenRes = await request(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: wrongVerifier,
      });
    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.access_token).toBeUndefined();
  });

  it("PKCE code_verifier を省略した場合、/token がトークン発行を拒否する", async () => {
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();
    const { clientId, code } = await obtainAuthorizationCode(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

    const tokenRes = await request(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        // code_verifier を意図的に省略
      });
    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.access_token).toBeUndefined();
  });

  it("ドメイン外/未検証トークンで /mcp を叩くと 401 になる", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(res.status).toBe(401);
  });

  it("offline_access を明示要求しても refresh_token は発行されない", async () => {
    const redirectUri = "http://localhost:1234/callback";
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const { clientId, code } = await obtainAuthorizationCode(
      app,
      redirectUri,
      codeChallenge,
      `${ISSUER_URL}/mcp`,
      "openid offline_access",
      ["authorization_code", "refresh_token"]
    );

    const tokenRes = await request(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.access_token).toBeTruthy();
    expect(tokenRes.body.refresh_token).toBeUndefined();
  });

  describe("サインイン拒否系", () => {
    it("email_verified が false の場合、firebase-callback は403を返しサインインを完了させない", async () => {
      const redirectUri = "http://localhost:1234/callback";
      const { codeChallenge } = generatePkcePair();
      const { jar, uid } = await startAuthorization(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

      mockVerifyIdToken.mockResolvedValueOnce(makeDecodedToken({ email_verified: false }));
      const res = await request(app)
        .post(`/interaction/${uid}/firebase-callback`)
        .set("Cookie", cookieHeader(jar))
        .send({ idToken: "fake-id-token" });
      expect(res.status).toBe(403);

      // サインインが完了していない(=interactionがloginプロンプトのまま)ことを確認。
      // verifyGoogleIdTokenがinteractionResultより前にthrowしていることの回帰検知。
      const page = await request(app).get(`/interaction/${uid}`).set("Cookie", cookieHeader(jar));
      expect(page.status).toBe(200);
      expect(page.text).toContain('id="signin"');
    });

    it("Google以外のプロバイダの場合、firebase-callback は403を返しサインインを完了させない", async () => {
      const redirectUri = "http://localhost:1234/callback";
      const { codeChallenge } = generatePkcePair();
      const { jar, uid } = await startAuthorization(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

      mockVerifyIdToken.mockResolvedValueOnce(
        makeDecodedToken({ firebase: { sign_in_provider: "password", identities: {} } })
      );
      const res = await request(app)
        .post(`/interaction/${uid}/firebase-callback`)
        .set("Cookie", cookieHeader(jar))
        .send({ idToken: "fake-id-token" });
      expect(res.status).toBe(403);
    });

    it("メールアドレスが取得できない場合、firebase-callback は403を返しサインインを完了させない", async () => {
      const redirectUri = "http://localhost:1234/callback";
      const { codeChallenge } = generatePkcePair();
      const { jar, uid } = await startAuthorization(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

      mockVerifyIdToken.mockResolvedValueOnce(makeDecodedToken({ email: undefined }));
      const res = await request(app)
        .post(`/interaction/${uid}/firebase-callback`)
        .set("Cookie", cookieHeader(jar))
        .send({ idToken: "fake-id-token" });
      expect(res.status).toBe(403);
    });

    it("idToken が未指定の場合、firebase-callback は400を返す", async () => {
      const redirectUri = "http://localhost:1234/callback";
      const { codeChallenge } = generatePkcePair();
      const { jar, uid } = await startAuthorization(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

      const res = await request(app).post(`/interaction/${uid}/firebase-callback`).set("Cookie", cookieHeader(jar)).send({});
      expect(res.status).toBe(400);
    });
  });

  it("ログイン未完了(まだloginプロンプト)の状態で /confirm を呼ぶと400を返す", async () => {
    // /confirm は consent プロンプトの時のみ有効。firebase-callback を経ずに
    // 直接 /confirm を呼ぶ(順序異常・古いconsent画面のブックマーク再訪等)場合の
    // router.ts の防御ロジック(name !== "consent" ガード)を検証する。
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();
    const { jar, uid } = await startAuthorization(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

    const res = await request(app).post(`/interaction/${uid}/confirm`).set("Cookie", cookieHeader(jar)).send({});
    expect(res.status).toBe(400);
  });

  it("interaction cookieが無い状態でconfirmを呼んでも、スタックトレースを含まない汎用エラーが返る", async () => {
    // Cloud Runインスタンス再起動等でinteraction sessionが失われた状態を模して
    // cookie無しで直接叩く。oidc-providerはSessionNotFoundを投げ、router.tsの
    // next(err)経由でapp.ts末尾の汎用エラーハンドラに到達する想定
    // (NODE_ENV未設定時のfinalhandlerスタックトレース漏洩の回帰テスト)。
    const res = await request(app).post("/interaction/nonexistent-uid/confirm").send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toMatch(/at \S+ \(.*:\d+:\d+\)/); // Node.jsスタックトレース行の典型パターン
    expect(res.text).not.toContain(".ts:");
    expect(res.text).not.toContain(".js:");
  });
});

describe("Phase 1a PR1: 同意画面の保存型XSS対策", () => {
  let app: Express;

  beforeAll(async () => {
    ({ app } = await createApp(ISSUER_URL, BIND_PORT));
  });

  beforeEach(() => {
    mockVerifyIdToken.mockReset();
  });

  it("DCRで登録した client_name に含まれるHTMLタグがエスケープされて同意画面に表示される", async () => {
    const redirectUri = "http://localhost:1234/callback";
    const maliciousClientName = '<script>alert(1)</script>';
    const reg = await request(app)
      .post("/reg")
      .set("Content-Type", "application/json")
      .send({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        client_name: maliciousClientName,
      });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;

    const { codeChallenge } = generatePkcePair();
    const query = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      resource: `${ISSUER_URL}/mcp`,
      scope: "openid",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    };
    const authRes = await request(app).get("/auth").query(query);
    let jar = mergeCookies(new Map(), authRes.headers["set-cookie"] as unknown as string[]);
    const loginUrl = new URL(authRes.headers.location as string, ISSUER_URL);
    const loginUid = loginUrl.pathname.slice("/interaction/".length).split("/")[0];

    mockVerifyIdToken.mockResolvedValueOnce(makeDecodedToken());
    const callbackRes = await request(app)
      .post(`/interaction/${loginUid}/firebase-callback`)
      .set("Cookie", cookieHeader(jar))
      .send({ idToken: "fake-id-token" });
    jar = mergeCookies(jar, callbackRes.headers["set-cookie"] as unknown as string[]);

    const resumePath = new URL(callbackRes.body.redirectTo as string, ISSUER_URL);
    const resumeRes = await request(app)
      .get(resumePath.pathname + resumePath.search)
      .set("Cookie", cookieHeader(jar));
    jar = mergeCookies(jar, resumeRes.headers["set-cookie"] as unknown as string[]);
    const consentUrl = new URL(resumeRes.headers.location as string, ISSUER_URL);
    const consentUid = consentUrl.pathname.slice("/interaction/".length).split("/")[0];

    const consentPage = await request(app)
      .get(consentUrl.pathname + consentUrl.search)
      .set("Cookie", cookieHeader(jar));
    expect(consentPage.status).toBe(200);
    expect(consentPage.text).not.toContain("<script>alert(1)</script>");
    expect(consentPage.text).toContain("&lt;script&gt;");
    expect(consentUid).toBeTruthy();
  });

  it("DCRで登録した redirect_uri に含まれるHTMLタグがエスケープされて同意画面に表示される", async () => {
    // client_name同様、views.ts冒頭コメントが脅威モデルとして明記するredirect_uriも
    // ルーター経由の実プラムビングでエスケープされることを確認する(unit testの
    // views.test.tsだけではrouter.tsでの取り回しミスを検知できない)。
    const maliciousRedirectUri = 'http://localhost:1234/callback?x="><img src=x onerror=alert(2)>';
    const reg = await request(app)
      .post("/reg")
      .set("Content-Type", "application/json")
      .send({
        redirect_uris: [maliciousRedirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const registeredRedirectUri = (reg.body.redirect_uris as string[])[0];

    const { codeChallenge } = generatePkcePair();
    const query = {
      client_id: clientId,
      redirect_uri: registeredRedirectUri,
      response_type: "code",
      resource: `${ISSUER_URL}/mcp`,
      scope: "openid",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    };
    const authRes = await request(app).get("/auth").query(query);
    expect([302, 303]).toContain(authRes.status);
    let jar = mergeCookies(new Map(), authRes.headers["set-cookie"] as unknown as string[]);
    const loginUrl = new URL(authRes.headers.location as string, ISSUER_URL);
    const loginUid = loginUrl.pathname.slice("/interaction/".length).split("/")[0];

    mockVerifyIdToken.mockResolvedValueOnce(makeDecodedToken());
    const callbackRes = await request(app)
      .post(`/interaction/${loginUid}/firebase-callback`)
      .set("Cookie", cookieHeader(jar))
      .send({ idToken: "fake-id-token" });
    jar = mergeCookies(jar, callbackRes.headers["set-cookie"] as unknown as string[]);

    const resumePath = new URL(callbackRes.body.redirectTo as string, ISSUER_URL);
    const resumeRes = await request(app)
      .get(resumePath.pathname + resumePath.search)
      .set("Cookie", cookieHeader(jar));
    jar = mergeCookies(jar, resumeRes.headers["set-cookie"] as unknown as string[]);
    const consentUrl = new URL(resumeRes.headers.location as string, ISSUER_URL);

    const consentPage = await request(app)
      .get(consentUrl.pathname + consentUrl.search)
      .set("Cookie", cookieHeader(jar));
    expect(consentPage.status).toBe(200);
    expect(consentPage.text).not.toContain('"><img src=x onerror=alert(2)>');
    expect(consentPage.text).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });
});

describe("Phase 0: Cloud Run 想定の回帰テスト（issuerUrlのホストとbindPortが異なる場合）", () => {
  it("issuerUrlの公開ホスト名がローカルには存在しなくても起動でき、絶対URLが正しく構築される", async () => {
    // 本番の Cloud Run では MCP_ISSUER_URL は公開ホスト名(例: https://mcp-xxx.run.app)だが、
    // コンテナは 0.0.0.0:$PORT で listen するだけで、公開ホスト名はローカルNICに割り当てられて
    // いない。fetchOidcMetadata がこの公開ホスト名に直接 bind しようとする実装だと、ここで
    // 起動時に確実に失敗する(Codex review PR #636 指摘・Critical)。
    const fakePublicIssuer = "https://mcp-fake-regression-test.example.invalid";
    const bindPort = 8093;

    const { app: cloudRunLikeApp } = await createApp(fakePublicIssuer, bindPort);

    const res = await request(cloudRunLikeApp)
      .get("/.well-known/oauth-authorization-server")
      .set("Host", "mcp-fake-regression-test.example.invalid");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(fakePublicIssuer);
    expect(res.body.authorization_endpoint).toBe(`${fakePublicIssuer}/auth`);
    expect(res.body.token_endpoint).toBe(`${fakePublicIssuer}/token`);
  });
});

describe("Phase 1a PR2: クロスインスタンス永続化（Firestore adapter を共有した2つの独立したcreateAppインスタンス）", () => {
  it("インスタンスAでDCR登録・認可コード取得したものを、インスタンスBでtoken交換〜ping呼び出しできる", async () => {
    // Cloud Run のリビジョン切替で別インスタンスに着地しても認可フローが継続できることの実証
    // (この PR の存在意義そのもの。計画 noble-purring-rabbit.md 検証項目#3)。
    const sharedDb = createFakeFirestore();
    const storageOptions = { adapter: createFirestoreAdapterFactory(sharedDb) };
    const firebaseConfig = { apiKey: "", authDomain: "", projectId: "" };

    const { app: appA } = await createApp(ISSUER_URL, 8094, firebaseConfig, storageOptions);
    const { app: appB } = await createApp(ISSUER_URL, 8095, firebaseConfig, storageOptions);

    const redirectUri = "http://localhost:1234/callback";
    const { codeVerifier, codeChallenge } = generatePkcePair();

    mockVerifyIdToken.mockResolvedValueOnce(makeDecodedToken());
    const { clientId, code } = await obtainAuthorizationCode(appA, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

    // token交換は別インスタンス(appB)で行う = DCR登録・認可コード発行がappAのプロセスローカル
    // メモリではなく共有Firestoreに永続化されていることの証明。
    const tokenRes = await request(appB).post("/token").type("form").send({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    expect(tokenRes.status).toBe(200);
    const accessToken = tokenRes.body.access_token as string;
    expect(accessToken).toBeTruthy();

    // 発行されたトークンでappA(=appBとは別インスタンス)の/mcpも呼べる
    const mcpRes = await request(appA)
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
});

describe("Phase 1b-1: Firebaseリフレッシュトークンの暗号化永続化", () => {
  function makeKeyring() {
    const key = crypto.randomBytes(32);
    return { keys: [{ version: 1, key }], activeVersion: 1 };
  }

  it("refreshTokenを送ると、暗号化されて mcp_user_credentials に保存される", async () => {
    const store = createCredentialStore(createFakeFirestore());
    const keyring = makeKeyring();
    const firebaseConfig = { apiKey: "", authDomain: "", projectId: "" };

    const { app } = await createApp(ISSUER_URL, 8096, firebaseConfig, {}, { store, keyring });
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();

    await obtainAuthorizationCode(
      app,
      redirectUri,
      codeChallenge,
      `${ISSUER_URL}/mcp`,
      "openid",
      ["authorization_code"],
      "my-refresh-token"
    );

    const stored = await store.find("test-firebase-uid");
    expect(stored).toBeDefined();
    expect(decryptWithKeyring(stored!.encryptedRefreshToken, keyring.keys)).toBe("my-refresh-token");
  });

  it("refreshTokenが未送信でもサインインは200で成功する（credential-storeは呼ばれない）", async () => {
    const store = createCredentialStore(createFakeFirestore());
    const keyring = makeKeyring();
    const firebaseConfig = { apiKey: "", authDomain: "", projectId: "" };
    const { app } = await createApp(ISSUER_URL, 8097, firebaseConfig, {}, { store, keyring });
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();

    const { code } = await obtainAuthorizationCode(app, redirectUri, codeChallenge, `${ISSUER_URL}/mcp`, "openid");

    expect(code).toBeTruthy();
    const stored = await store.find("test-firebase-uid");
    expect(stored).toBeUndefined();
  });

  it("store.saveが失敗してもサインインは200で成功する（保存失敗はサインインを阻害しない。pr-review-toolkitセカンドオピニオン指摘: 実際にstore.saveがthrowする経路の検証）", async () => {
    const keyring = makeKeyring();
    const failingStore = {
      save: async () => {
        throw new Error("firestore down");
      },
      find: async () => undefined,
      delete: async () => {},
    };
    const firebaseConfig = { apiKey: "", authDomain: "", projectId: "" };
    const { app } = await createApp(ISSUER_URL, 8099, firebaseConfig, {}, { store: failingStore, keyring });
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();

    const { code } = await obtainAuthorizationCode(
      app,
      redirectUri,
      codeChallenge,
      `${ISSUER_URL}/mcp`,
      "openid",
      ["authorization_code"],
      "my-refresh-token"
    );

    expect(code).toBeTruthy();
  });

  it("サインイン時に暗号化保存されたrefreshTokenを、credential-service.tsが復号・交換して実際にidTokenを取得できる（write経路とread経路のE2E結合。pr-test-analyzerセカンドオピニオン指摘: 両者が別々の低レベルプリミティブに対してしかテストされておらず結合されていなかった）", async () => {
    const store = createCredentialStore(createFakeFirestore());
    const keyring = makeKeyring();
    const firebaseConfig = { apiKey: "", authDomain: "", projectId: "" };

    const { app } = await createApp(ISSUER_URL, 8100, firebaseConfig, {}, { store, keyring });
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();

    await obtainAuthorizationCode(
      app,
      redirectUri,
      codeChallenge,
      `${ISSUER_URL}/mcp`,
      "openid",
      ["authorization_code"],
      "my-refresh-token"
    );

    const exchangeMock = vi
      .fn()
      .mockResolvedValue({ idToken: "fresh-id-token", refreshToken: "rotated-refresh-token", expiresIn: 3600 });
    const credentialService = createCredentialService({
      store,
      keyring,
      firebaseWebApiKey: "api-key",
      exchange: exchangeMock,
    });

    const idToken = await credentialService.getFirebaseIdTokenForAccount("test-firebase-uid");

    expect(idToken).toBe("fresh-id-token");
    // router.ts が保存した暗号文を credential-service.ts が正しく復号できたことの証明
    // （decryptWithKeyringへ渡された平文が、サインイン時に送った値と一致）
    expect(exchangeMock).toHaveBeenCalledWith("my-refresh-token", "api-key");
  });

  it("credentialOptions未指定（従来どおり）でもサインインは影響を受けない", async () => {
    const firebaseConfig = { apiKey: "", authDomain: "", projectId: "" };
    const { app } = await createApp(ISSUER_URL, 8098, firebaseConfig, {});
    const redirectUri = "http://localhost:1234/callback";
    const { codeChallenge } = generatePkcePair();

    const { code } = await obtainAuthorizationCode(
      app,
      redirectUri,
      codeChallenge,
      `${ISSUER_URL}/mcp`,
      "openid",
      ["authorization_code"],
      "my-refresh-token"
    );

    expect(code).toBeTruthy();
  });
});
