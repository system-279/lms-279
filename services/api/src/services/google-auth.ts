import { google, type drive_v3, type docs_v1 } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];

const WORKSPACE_ADMIN_EMAIL = process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;

let driveClient: drive_v3.Drive | null = null;
let docsClient: docs_v1.Docs | null = null;

/**
 * Domain-Wide Delegation 用の JWT 認証クライアントを生成
 * サービスアカウントが WORKSPACE_ADMIN_EMAIL を impersonate して
 * 279279.net ドメイン内のファイルにアクセスする
 */
function createAuthClient() {
  if (!WORKSPACE_ADMIN_EMAIL) {
    throw new Error(
      "GOOGLE_WORKSPACE_ADMIN_EMAIL is required for Google Workspace integration"
    );
  }

  const auth = new google.auth.GoogleAuth({
    scopes: SCOPES,
    clientOptions: {
      subject: WORKSPACE_ADMIN_EMAIL,
    },
  });

  return auth;
}

/**
 * Google Drive API クライアント（シングルトン）
 */
export function getDriveClient(): drive_v3.Drive {
  if (!driveClient) {
    const auth = createAuthClient();
    driveClient = google.drive({ version: "v3", auth });
  }
  return driveClient;
}

/**
 * Google Docs API クライアント（シングルトン）
 */
export function getDocsClient(): docs_v1.Docs {
  if (!docsClient) {
    const auth = createAuthClient();
    docsClient = google.docs({ version: "v1", auth });
  }
  return docsClient;
}

/**
 * Google Workspace 連携が利用可能か確認
 */
export function isWorkspaceIntegrationAvailable(): boolean {
  return !!WORKSPACE_ADMIN_EMAIL;
}
