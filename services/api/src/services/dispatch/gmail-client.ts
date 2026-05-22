/**
 * DXcollege 自動完了通知用の Gmail API クライアント (専用、ADR-037 案 X 反映)。
 *
 * 設計仕様書 §5.3、FR-5 (改訂)、NFR-9 (改訂)、AC-3 / AC-34 に対応。
 *
 * 既存 `services/google-auth.ts` の共通 SCOPES とは**意図的に分離**する。
 * Codex Important-1 反映: gmail.send scope を既存 Drive/Docs/Sheets 用 JWT に
 * 追加すると、Drive/Docs/Sheets 経路の事故時影響範囲が拡がる。
 * 専用クライアントとして cache key を分離 (subject, scope) し、相互非干渉を保証する。
 *
 * SendAs (ADR-037 案 X) 方針:
 *   - JWT subject = `subjectEmail` (実在 mailbox、初期値 `system@279279.net`)
 *   - 専用 scope = `gmail.send` のみ
 *   - MIME `From:` ヘッダは呼び出し側で `fromEmail` を使って組み立てる
 *     (Gmail SendAs 機能で fromEmail エイリアスを subjectEmail の Gmail に登録済の前提)
 *   - 本関数は SendAs 設定の存在検証を行わない (gmail.send 時に Gmail API 側で reject)
 *
 * テスト容易性:
 *   - `googleapis` / `@google-cloud/secret-manager` は vi.mock で差し替える
 *     (services/api/src/services/__tests__/gmail-draft.test.ts の hoisted mock パターン参照)
 *   - cache のクリアは `__resetCacheForTest` で行う (本番経路では呼ばない)
 */

import { google, type gmail_v1 } from "googleapis";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { DWD_SECRET_NAME } from "../google-auth.js";

/** ADR-037 案 X: 専用 client は gmail.send のみを保持する */
export const DISPATCH_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

interface DwdKey {
  client_email: string;
  private_key: string;
}

interface CachedClient {
  /** cache key 検証用 (subject + scope のみで一意化、ADR-037) */
  cacheKey: string;
  client: gmail_v1.Gmail;
}

/**
 * cache key: `${subjectEmail}|${scope}` のフラット文字列。
 * 既存 `google-auth.ts` の cache とは別マップで管理する (Important-1)。
 *
 * 運用注意 (Secret Manager 鍵ローテーション):
 *   `cachedDwdKey` は最初の呼び出しで読み取り後プロセス終了までメモリ保持される。
 *   Secret Manager で `dwd-workspace-key` をローテーションした場合、本プロセスは
 *   旧鍵を使い続けるため Cloud Run の revision 再デプロイ (= プロセス再起動) が
 *   必須となる。既存 `google-auth.ts` の `cachedAdminEmail` 経由 cache invalidation
 *   とは独立しているため、`process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL` 変更による
 *   間接 invalidation は発生しない。
 */
const clientCache = new Map<string, CachedClient>();
let secretManagerClient: SecretManagerServiceClient | null = null;
let cachedDwdKey: DwdKey | null = null;

async function loadDwdKey(): Promise<DwdKey> {
  if (cachedDwdKey) return cachedDwdKey;
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  const [version] = await secretManagerClient.accessSecretVersion({
    name: DWD_SECRET_NAME,
  });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(
      "DWD service account key not found in Secret Manager (dispatch)",
    );
  }
  const keyData = typeof payload === "string" ? payload : payload.toString();
  const parsed = JSON.parse(keyData) as DwdKey;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("DWD service account key is malformed (dispatch)");
  }
  cachedDwdKey = parsed;
  return parsed;
}

function buildCacheKey(subjectEmail: string): string {
  return `${subjectEmail}|${DISPATCH_GMAIL_SCOPE}`;
}

/**
 * 専用 Gmail クライアントを取得する。
 *
 * @param subjectEmail DWD JWT subject (実在 mailbox、`DXCOLLEGE_DISPATCH_SUBJECT` env)
 * @param fromEmail   MIME From ヘッダ用エイリアス (`DXCOLLEGE_SENDER_EMAIL` env、SendAs 登録済)。
 *                    本関数内では空文字 validation のみ行い、JWT / cache key には含めない。
 *                    呼び出し側に「同一の fromEmail で MIME 組立まで完結させる」依存を
 *                    シグネチャレベルで強制する設計 (spec FR-5 改訂、ADR-037 §実装方針 4)。
 *                    cache key を (subject, scope) のみに限定する理由は同 spec / Important-1。
 * @returns gmail_v1.Gmail インスタンス (cache hit なら同一参照)
 */
export async function getGmailClientForSender(
  subjectEmail: string,
  fromEmail: string,
): Promise<gmail_v1.Gmail> {
  if (typeof subjectEmail !== "string" || subjectEmail.length === 0) {
    throw new Error("subjectEmail must be a non-empty string");
  }
  if (typeof fromEmail !== "string" || fromEmail.length === 0) {
    throw new Error("fromEmail must be a non-empty string");
  }

  const cacheKey = buildCacheKey(subjectEmail);
  const cached = clientCache.get(cacheKey);
  if (cached) return cached.client;

  const keyData = await loadDwdKey();
  const auth = new google.auth.JWT({
    email: keyData.client_email,
    key: keyData.private_key,
    scopes: [DISPATCH_GMAIL_SCOPE],
    subject: subjectEmail,
  });
  const client = google.gmail({ version: "v1", auth });
  clientCache.set(cacheKey, { cacheKey, client });
  return client;
}

/**
 * cache 状態を返す (テスト専用)。本番経路では呼ばない。
 * `__` prefix で意図しない本番利用を構造的に防ぐ。
 */
export function __getCacheStatsForTest(): { size: number; keys: string[] } {
  return {
    size: clientCache.size,
    keys: Array.from(clientCache.keys()),
  };
}

/**
 * cache 全クリア (テスト専用)。本番経路では呼ばない。
 */
export function __resetCacheForTest(): void {
  clientCache.clear();
  cachedDwdKey = null;
  secretManagerClient = null;
}
