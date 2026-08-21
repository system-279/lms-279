/**
 * devInteractions 置き換えの HTML ページ生成。
 *
 * DCR は initialAccessToken:false で誰でもクライアント登録できるため、同意画面に
 * 表示する client_name / redirect_uri を無エスケープで埋め込むと保存型 XSS になる。
 * AI 出力・外部入力由来の文字列をテンプレートへ差し込む箇所は必ず escapeHtml を経由
 * すること（レビュー時の最重点確認項目）。
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * <script>ブロック内へ値を埋め込む専用の JSON エンコード。
 * JSON.stringify は `<`/`/` をエスケープしないため、埋め込み値に
 * `</script>` が含まれると script タグが早期終了し任意マークアップ注入に
 * つながりうる（escapeHtml とは別軸のリスク。現状 uid は oidc-provider の
 * nanoid由来、firebaseConfigはサーバー側env由来でいずれも攻撃者制御不可だが、
 * 将来この埋め込みパターンを他の値へ流用しても安全なように防御しておく）。
 */
function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

const FIREBASE_SDK_VERSION = "12.14.0";

function pageShell(title: string, bodyHtml: string, scriptHtml: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px; color: #1a1a1a; }
  button { font-size: 16px; padding: 10px 20px; margin-right: 8px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; background: #fff; }
  button.primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
  #status { margin-top: 16px; color: #b3261e; white-space: pre-wrap; }
</style>
</head>
<body>
${bodyHtml}
<p id="status"></p>
<script type="module">
${scriptHtml}
</script>
</body>
</html>`;
}

export function renderLoginPage(params: { uid: string; firebaseConfig: FirebaseWebConfig }): string {
  const { uid, firebaseConfig } = params;
  const body = `
<h1>LMS Quiz MCP へのサインイン</h1>
<p>Google アカウントでサインインしてください。</p>
<button id="signin" class="primary">Google でサインイン</button>
`;
  const script = `
import { initializeApp } from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js";

const app = initializeApp(${toScriptJson(firebaseConfig)});
const auth = getAuth(app);
const statusEl = document.getElementById("status");

document.getElementById("signin").addEventListener("click", async () => {
  statusEl.textContent = "";
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    const idToken = await result.user.getIdToken();
    const res = await fetch(${toScriptJson(`/interaction/${uid}/firebase-callback`)}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    if (res.ok && data.redirectTo) {
      location.assign(data.redirectTo);
    } else {
      statusEl.textContent = "サインインに失敗しました: " + (data.error ?? res.status);
    }
  } catch (err) {
    statusEl.textContent = "サインインに失敗しました: " + (err && err.message ? err.message : String(err));
  }
});
`;
  return pageShell("サインイン", body, script);
}

export function renderConsentPage(params: {
  uid: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
}): string {
  const { uid, clientName, redirectUri, scopes } = params;
  const scopeItems = scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  const body = `
<h1>アクセス許可の確認</h1>
<p><strong>${escapeHtml(clientName)}</strong> が以下の権限を要求しています:</p>
<ul>${scopeItems}</ul>
<p>連携後のリダイレクト先: <code>${escapeHtml(redirectUri)}</code></p>
<button id="approve" class="primary">許可</button>
<button id="deny">拒否</button>
`;
  const confirmUrl = toScriptJson(`/interaction/${uid}/confirm`);
  const abortUrl = toScriptJson(`/interaction/${uid}/abort`);
  const script = `
const statusEl = document.getElementById("status");

async function submit(url) {
  statusEl.textContent = "";
  try {
    const res = await fetch(url, { method: "POST" });
    const data = await res.json();
    if (res.ok && data.redirectTo) {
      location.assign(data.redirectTo);
    } else {
      statusEl.textContent = "処理に失敗しました: " + (data.error ?? res.status);
    }
  } catch (err) {
    statusEl.textContent = "処理に失敗しました: " + (err && err.message ? err.message : String(err));
  }
}

document.getElementById("approve").addEventListener("click", () => submit(${confirmUrl}));
document.getElementById("deny").addEventListener("click", () => submit(${abortUrl}));
`;
  return pageShell("アクセス許可の確認", body, script);
}

export function renderErrorPage(message: string): string {
  const body = `<h1>エラー</h1><p>${escapeHtml(message)}</p>`;
  return pageShell("エラー", body, "");
}
