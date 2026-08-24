/**
 * env 読み込み・検証。Cloud Run 実行時（K_SERVICE 自動注入）に必須値が欠けていたら
 * fail-fast で起動しない（services/api/src/middleware/tenant-auth.ts:27-54 と同じ
 * パターン。ローカル/CI では K_SERVICE が無いため未設定でも起動を許容する）。
 */

export interface McpConfig {
  port: number;
  issuerUrl: string;
  firebaseProjectId: string | undefined;
  firebaseWebApiKey: string | undefined;
  firebaseAuthDomain: string | undefined;
  /** "firestore" のとき永続adapter+Secret Manager署名鍵を使う。それ以外は既定のインメモリ実装 */
  storage: "firestore" | "memory";
  mcpSigningSecretName: string | undefined;
  /** Phase 1b-1: Firebaseリフレッシュトークン暗号化用の鍵環（OIDC署名鍵とは別シークレット） */
  mcpCredentialSecretName: string | undefined;
  /** Phase 2a: quizツールが呼び出す services/api のベースURL（Cloud RunのURL） */
  lmsApiBaseUrl: string | undefined;
  /**
   * Phase 2b PR C1: テナント自己一致ガードの動作モード。
   * "dry-run"（既定） = 拒否対象を検知しても実際にはブロックせず記録のみ。
   * "enforce" = 実際にブロックする。本番影響範囲を確認してから手動で切り替える
   * （計画magical-noodling-duckling.md「PR C1」節参照）。
   */
  tenantGuardMode: "dry-run" | "enforce";
}

function parseTenantGuardMode(): "dry-run" | "enforce" {
  const raw = process.env.MCP_TENANT_GUARD_MODE;
  if (raw === undefined || raw === "dry-run") return "dry-run";
  if (raw === "enforce") return "enforce";
  throw new Error(
    `FATAL: invalid MCP_TENANT_GUARD_MODE "${raw}" (must be "dry-run" or "enforce", services/mcp/src/config.ts)。`
  );
}

function isProductionRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === "production") return true;
  // Cloud Run は起動時に K_SERVICE を必ず注入する。NODE_ENV 設定漏れ時の保険。
  if (typeof process.env.K_SERVICE === "string" && process.env.K_SERVICE.length > 0) return true;
  return false;
}

export function loadConfig(): McpConfig {
  const port = Number(process.env.PORT) || 8082;
  const issuerUrl = process.env.MCP_ISSUER_URL ?? `http://127.0.0.1:${port}`;
  const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
  const firebaseWebApiKey = process.env.FIREBASE_WEB_API_KEY;
  const firebaseAuthDomain = process.env.FIREBASE_AUTH_DOMAIN;
  const storage: "firestore" | "memory" = process.env.MCP_STORAGE === "firestore" ? "firestore" : "memory";
  const mcpSigningSecretName = process.env.MCP_SIGNING_SECRET_NAME;
  const mcpCredentialSecretName = process.env.MCP_CREDENTIAL_SECRET_NAME;
  const lmsApiBaseUrl = process.env.LMS_API_BASE_URL;
  const tenantGuardMode = parseTenantGuardMode();

  if (isProductionRuntime()) {
    const missing = [
      ["FIREBASE_PROJECT_ID", firebaseProjectId],
      ["FIREBASE_WEB_API_KEY", firebaseWebApiKey],
      ["FIREBASE_AUTH_DOMAIN", firebaseAuthDomain],
      ["LMS_API_BASE_URL", lmsApiBaseUrl],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(
        `FATAL: missing required env var(s) in production runtime: ${missing.join(", ")}. ` +
          `Firebase Google サインインが機能しないため起動しない ` +
          `(services/mcp/src/config.ts、.github/workflows/deploy.yml の deploy-mcp job を確認)。`
      );
    }

    // Phase 1a PR2: 本番では必ず Firestore 永続化 + Secret Manager 署名鍵を使う
    // (インメモリのままだと Cloud Run 再デプロイで DCR 登録クライアントが失効する)。
    if (storage !== "firestore") {
      throw new Error(
        "FATAL: MCP_STORAGE=firestore is required in production runtime " +
          "(services/mcp/src/config.ts、.github/workflows/deploy.yml の deploy-mcp job を確認)。"
      );
    }
    if (!mcpSigningSecretName) {
      throw new Error(
        "FATAL: missing required env var MCP_SIGNING_SECRET_NAME in production runtime " +
          "(services/mcp/src/config.ts、.github/workflows/deploy.yml の deploy-mcp job を確認)。"
      );
    }
    if (!mcpCredentialSecretName) {
      throw new Error(
        "FATAL: missing required env var MCP_CREDENTIAL_SECRET_NAME in production runtime " +
          "(services/mcp/src/config.ts、.github/workflows/deploy.yml の deploy-mcp job を確認)。"
      );
    }
  }

  return {
    port,
    issuerUrl,
    firebaseProjectId,
    firebaseWebApiKey,
    firebaseAuthDomain,
    storage,
    mcpSigningSecretName,
    mcpCredentialSecretName,
    lmsApiBaseUrl,
    tenantGuardMode,
  };
}
