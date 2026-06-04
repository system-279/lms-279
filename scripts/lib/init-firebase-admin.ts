/**
 * dispatch dry-run CLI 用の Firebase Admin SDK 初期化 helper (Phase 4 α-7、safe-refactor M1)。
 *
 * scripts/dispatch-dry-run-cli.ts と scripts/progress-report-dry-run-cli.ts で
 * 完全重複していた `initFirestore()` 関数と env 読み取り定数を抽出。
 *
 * - GOOGLE_APPLICATION_CREDENTIALS が指す JSON の type field を見て
 *   service_account / WIF (ADC) を切り分け
 * - 認証経路を `console.error` で出力 (workflow log で診断容易)
 *
 * 関連:
 *   - 設計仕様書 / 旧 CLI コメント: 「ローカル ADC 経由」「workflow_dispatch WIF 認証」両対応
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  applicationDefault,
  cert,
  initializeApp,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/** GCP プロジェクト ID (env 優先、未設定時 default `lms-279`) */
export const GCP_PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.FIREBASE_PROJECT_ID ??
  "lms-279";

/** dispatch 送信元 email (env 優先、未設定時 default `dxcollege@279279.net`) */
export const SENDER_EMAIL =
  process.env.DXCOLLEGE_SENDER_EMAIL ?? "dxcollege@279279.net";

/**
 * Firebase Admin SDK を初期化し Firestore client を返す。
 *
 * 認証経路の優先順位:
 *   1. `GOOGLE_APPLICATION_CREDENTIALS` 指定 + JSON の `type === "service_account"`
 *      → service account JSON 経由 (ローカル開発で多用)
 *   2. `GOOGLE_APPLICATION_CREDENTIALS` 指定 + その他 type
 *      → ADC 経由 (WIF 想定、cred file は WIF 設定ファイル)
 *   3. 未指定 → ADC 経由 (gcloud / metadata server 等)
 */
export function initFirestoreForCli(): Firestore {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    const jsonPath = resolve(process.cwd(), credPath);
    const credJson = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
      type?: string;
    };
    if (credJson.type === "service_account") {
      initializeApp({ credential: cert(credJson as ServiceAccount) });
      console.error(`[init] 認証: サービスアカウント JSON (${jsonPath})`);
    } else {
      initializeApp({ credential: applicationDefault() });
      console.error(
        `[init] 認証: ADC (cred file type=${credJson.type ?? "unknown"}, WIF 想定)`,
      );
    }
  } else {
    initializeApp({ credential: applicationDefault() });
    console.error("[init] 認証: Application Default Credentials");
  }
  return getFirestore();
}
