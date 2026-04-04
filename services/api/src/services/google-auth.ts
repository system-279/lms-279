import { google, type drive_v3, type docs_v1, type sheets_v4 } from "googleapis";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

const GCP_PROJECT_ID = "lms-279";
const DWD_SECRET_NAME = `projects/${GCP_PROJECT_ID}/secrets/dwd-workspace-key/versions/latest`;

// シングルトンインスタンス
let authClient: InstanceType<typeof google.auth.JWT> | null = null;
let driveClient: drive_v3.Drive | null = null;
let docsClient: docs_v1.Docs | null = null;
let sheetsClient: sheets_v4.Sheets | null = null;
let cachedAdminEmail: string | null = null;
let secretManagerClient: SecretManagerServiceClient | null = null;

/**
 * Secret Managerからサービスアカウントキーを取得
 */
async function getDwdKeyFromSecretManager(): Promise<{
  client_email: string;
  private_key: string;
}> {
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  const [version] = await secretManagerClient.accessSecretVersion({
    name: DWD_SECRET_NAME,
  });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error("DWD service account key not found in Secret Manager");
  }
  const keyData = typeof payload === "string" ? payload : payload.toString();
  return JSON.parse(keyData);
}

/**
 * Domain-Wide Delegation 用の認証クライアント（シングルトン）
 * Secret ManagerからDWD専用SAキーを取得し、subject指定でJWT認証
 */
async function getAuthClient(): Promise<InstanceType<typeof google.auth.JWT>> {
  const email = process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;

  if (!email) {
    throw new Error(
      "GOOGLE_WORKSPACE_ADMIN_EMAIL is required for Google Workspace integration"
    );
  }

  // メールが変わった場合はクライアントを再作成
  if (!authClient || cachedAdminEmail !== email) {
    const keyData = await getDwdKeyFromSecretManager();
    cachedAdminEmail = email;
    authClient = new google.auth.JWT({
      email: keyData.client_email,
      key: keyData.private_key,
      scopes: SCOPES,
      subject: email,
    });
    // 認証が変わったのでAPIクライアントもリセット
    driveClient = null;
    docsClient = null;
    sheetsClient = null;
  }
  return authClient;
}

/**
 * Google Drive API クライアント（シングルトン）
 */
export async function getDriveClient(): Promise<drive_v3.Drive> {
  if (!driveClient) {
    const auth = await getAuthClient();
    driveClient = google.drive({ version: "v3", auth });
  }
  return driveClient;
}

/**
 * Google Docs API クライアント（シングルトン）
 */
export async function getDocsClient(): Promise<docs_v1.Docs> {
  if (!docsClient) {
    const auth = await getAuthClient();
    docsClient = google.docs({ version: "v1", auth });
  }
  return docsClient;
}

/**
 * Google Sheets API クライアント（シングルトン）
 */
export async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (!sheetsClient) {
    const auth = await getAuthClient();
    sheetsClient = google.sheets({ version: "v4", auth });
  }
  return sheetsClient;
}

/**
 * 指定ユーザーのsubjectで認証したSheets+Driveクライアントを返す
 * 操作ユーザーのマイドライブにスプレッドシートを作成するために使用
 * シングルトンキャッシュには影響しない（リクエストごとに生成）
 */
export async function getClientsForUser(userEmail: string): Promise<{
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
}> {
  const keyData = await getDwdKeyFromSecretManager();
  const auth = new google.auth.JWT({
    email: keyData.client_email,
    key: keyData.private_key,
    scopes: SCOPES,
    subject: userEmail,
  });
  return {
    sheets: google.sheets({ version: "v4", auth }),
    drive: google.drive({ version: "v3", auth }),
  };
}

/**
 * Google Workspace 連携が利用可能か確認
 * リクエスト時に環境変数を読み取る
 */
export function isWorkspaceIntegrationAvailable(): boolean {
  return !!process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;
}
