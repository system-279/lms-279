import { google, type drive_v3, type docs_v1 } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];

// シングルトンインスタンス
let authClient: InstanceType<typeof google.auth.GoogleAuth> | null = null;
let driveClient: drive_v3.Drive | null = null;
let docsClient: docs_v1.Docs | null = null;
let cachedAdminEmail: string | null = null;

/**
 * Domain-Wide Delegation 用の認証クライアント（シングルトン）
 * 環境変数はリクエスト時に読み取る（Cloud Runのコンテナ再利用に対応）
 */
function getAuthClient() {
  const email = process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;

  if (!email) {
    throw new Error(
      "GOOGLE_WORKSPACE_ADMIN_EMAIL is required for Google Workspace integration"
    );
  }

  // メールが変わった場合はクライアントを再作成
  if (!authClient || cachedAdminEmail !== email) {
    cachedAdminEmail = email;
    authClient = new google.auth.GoogleAuth({
      scopes: SCOPES,
      clientOptions: {
        subject: email,
      },
    });
    // 認証が変わったのでAPIクライアントもリセット
    driveClient = null;
    docsClient = null;
  }
  return authClient;
}

/**
 * Google Drive API クライアント（シングルトン）
 */
export function getDriveClient(): drive_v3.Drive {
  if (!driveClient) {
    driveClient = google.drive({ version: "v3", auth: getAuthClient() });
  }
  return driveClient;
}

/**
 * Google Docs API クライアント（シングルトン）
 */
export function getDocsClient(): docs_v1.Docs {
  if (!docsClient) {
    docsClient = google.docs({ version: "v1", auth: getAuthClient() });
  }
  return docsClient;
}

/**
 * Google Workspace 連携が利用可能か確認
 * リクエスト時に環境変数を読み取る
 */
export function isWorkspaceIntegrationAvailable(): boolean {
  return !!process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;
}
