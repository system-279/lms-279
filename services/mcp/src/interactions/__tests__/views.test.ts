import { describe, it, expect } from "vitest";
import { escapeHtml, renderLoginPage, renderConsentPage, renderErrorPage } from "../views.js";

describe("escapeHtml", () => {
  it("危険文字を全てエスケープする", () => {
    expect(escapeHtml(`<script>alert('x')</script>&"quoted"`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;&quot;quoted&quot;"
    );
  });

  it("危険文字を含まない文字列はそのまま返す", () => {
    expect(escapeHtml("普通のクライアント名")).toBe("普通のクライアント名");
  });
});

const firebaseConfig = { apiKey: "test-api-key", authDomain: "test.firebaseapp.com", projectId: "test-project" };

describe("renderLoginPage", () => {
  it("Googleサインインボタンを含む", () => {
    const html = renderLoginPage({ uid: "test-uid", firebaseConfig });
    expect(html).toContain('id="signin"');
    expect(html).toContain("/interaction/test-uid/firebase-callback");
  });

  it("firebaseConfig の値をJSONとして埋め込む（オブジェクトインジェクションを防ぐ）", () => {
    const html = renderLoginPage({ uid: "test-uid", firebaseConfig });
    expect(html).toContain(JSON.stringify(firebaseConfig));
  });
});

describe("renderConsentPage", () => {
  it("client_name / redirect_uri をエスケープして埋め込む(保存型XSS対策)", () => {
    const html = renderConsentPage({
      uid: "test-uid",
      clientName: "<script>alert(1)</script>",
      redirectUri: '"><img src=x onerror=alert(2)>',
      scopes: ["openid"],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("scope一覧を表示する", () => {
    const html = renderConsentPage({
      uid: "test-uid",
      clientName: "LMS Quiz Client",
      redirectUri: "http://localhost:1234/callback",
      scopes: ["openid", "offline_access"],
    });
    expect(html).toContain("<li>openid</li>");
    expect(html).toContain("<li>offline_access</li>");
  });

  it("許可/拒否ボタンを含む", () => {
    const html = renderConsentPage({
      uid: "test-uid",
      clientName: "LMS Quiz Client",
      redirectUri: "http://localhost:1234/callback",
      scopes: ["openid"],
    });
    expect(html).toContain('id="approve"');
    expect(html).toContain('id="deny"');
    expect(html).toContain("/interaction/test-uid/confirm");
    expect(html).toContain("/interaction/test-uid/abort");
  });
});

describe("renderErrorPage", () => {
  it("メッセージをエスケープして表示する", () => {
    const html = renderErrorPage("<script>alert(3)</script>");
    expect(html).not.toContain("<script>alert(3)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
