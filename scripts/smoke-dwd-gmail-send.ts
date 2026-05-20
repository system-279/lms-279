#!/usr/bin/env npx tsx
/**
 * Phase 0-A-4 (OQ-2) Group エイリアス DWD smoke check スクリプト。
 *
 * 目的:
 *   `dxcollege@279279.net` が Google Group エイリアスでも、DWD subject として
 *   `gmail.users.messages.send` が成功するかを実機検証する。
 *   失敗した場合は設計仕様書 OQ-2 の代替案 (SendAs 設定 or 実ユーザー mailbox 化) を
 *   本田様判断で検討する必要がある。
 *
 * 動作モード:
 *   --dry-run (既定): DWD 認証 + JWT 生成 + MIME 組立まで実行、Gmail API 呼出しは行わない
 *   --send: 上記に加え、実際に Gmail API で送信する
 *
 * 安全機構:
 *   - --dry-run 既定 (--send で実送信)
 *   - --to (必須): 送信先 email、明示指定。誤入力防止。
 *   - --subject (任意): 件名、既定 "[smoke] DXcollege 自動完了通知 DWD smoke check"
 *   - 本文は固定 (PII を含まないダミー文)
 *   - 添付なし (本番 PDF 生成パスは別 phase で検証)
 *   - 実行ログには messageId のみ出力、本文/宛先 raw は出さない
 *
 * 使用方法:
 *   # ローカル (ADC 経由、要 GOOGLE_APPLICATION_CREDENTIALS or gcloud auth):
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/smoke-dwd-gmail-send.ts \
 *     --to=engineer@example.com --dry-run
 *
 *   # workflow_dispatch (WIF 認証):
 *   GitHub Actions UI > Smoke DWD Gmail Send > Run workflow
 *
 * 関連:
 *   - 設計仕様書: docs/specs/2026-05-20-completion-notification-design.md OQ-2
 *   - 実装計画: docs/specs/2026-05-20-completion-notification-impl-plan.md Phase 0-A-4
 *   - 既存 DWD 基盤: services/api/src/services/google-auth.ts
 */

import { google } from "googleapis";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const GCP_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "lms-279";
const DWD_SECRET_NAME = `projects/${GCP_PROJECT_ID}/secrets/dwd-workspace-key/versions/latest`;
// 設計仕様書 NFR-8 / Phase 7 で Cloud Run env に追加予定。ローカル smoke では引数で上書き可能。
const DEFAULT_SENDER = process.env.DXCOLLEGE_SENDER_EMAIL ?? "dxcollege@279279.net";

// ============================================================
// CLI 引数パース
// ============================================================

interface CliOptions {
  to: string;
  subject: string;
  sender: string;
  send: boolean; // true なら実送信、false (既定) なら dry-run
}

function parseArgs(argv: string[]): CliOptions {
  let to: string | null = null;
  let subject = "[smoke] DXcollege 自動完了通知 DWD smoke check";
  let sender = DEFAULT_SENDER;
  let send = false;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length).trim();
    } else if (arg.startsWith("--subject=")) {
      subject = arg.slice("--subject=".length).trim();
    } else if (arg.startsWith("--sender=")) {
      sender = arg.slice("--sender=".length).trim();
    } else if (arg === "--send") {
      send = true;
    } else if (arg === "--dry-run") {
      send = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: smoke-dwd-gmail-send.ts --to=<email> [--subject=...] [--sender=...] [--send|--dry-run]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (!to) {
    console.error("FATAL: --to=<email> is required (送信先指定なしでは smoke 不可)");
    process.exit(2);
  }

  // 簡易バリデーション (smoke なので最小限)
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(to)) {
    console.error(`FATAL: --to does not look like a valid email: ${to}`);
    process.exit(2);
  }
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(sender)) {
    console.error(`FATAL: --sender does not look like a valid email: ${sender}`);
    process.exit(2);
  }

  return { to, subject, sender, send };
}

// ============================================================
// Secret Manager から DWD SA キー取得
// ============================================================

async function getDwdKey(): Promise<{ client_email: string; private_key: string }> {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: DWD_SECRET_NAME });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`DWD service account key not found at ${DWD_SECRET_NAME}`);
  }
  const keyData = typeof payload === "string" ? payload : payload.toString();
  return JSON.parse(keyData);
}

// ============================================================
// MIME 組立 (ダミー本文、添付なし)
// ============================================================

function buildRawMime(opts: {
  to: string;
  sender: string;
  subject: string;
}): string {
  // Gmail API messages.send は base64url エンコード済の MIME を期待
  const body = [
    `From: ${opts.sender}`,
    `To: ${opts.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(opts.subject, "utf-8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    "This is a DWD smoke test message for DXcollege completion notification system.",
    "If you received this, the DWD subject = dxcollege@279279.net is working.",
    "",
    "Phase 0-A-4 (OQ-2) smoke check",
    "Related: docs/specs/2026-05-20-completion-notification-design.md",
  ].join("\r\n");

  return Buffer.from(body, "utf-8").toString("base64url");
}

// ============================================================
// メイン
// ============================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  console.log(`Mode: ${opts.send ? "SEND (実送信)" : "DRY-RUN (Gmail API 呼出しなし)"}`);
  console.log(`Sender (DWD subject): ${opts.sender}`);
  console.log(`Recipient: ${opts.to}`);
  console.log(`Subject: ${opts.subject}`);
  console.log("---");

  console.log("Step 1: Secret Manager から DWD SA キーを取得...");
  const keyData = await getDwdKey();
  console.log(`  ✓ SA client_email: ${keyData.client_email}`);

  console.log("Step 2: gmail.send 専用 JWT 生成 (scope を共通 client と分離)...");
  const auth = new google.auth.JWT({
    email: keyData.client_email,
    key: keyData.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    subject: opts.sender, // ← なりすまし対象
  });
  await auth.authorize();
  console.log("  ✓ JWT 認可成功 (DWD scope 反映済み)");

  console.log("Step 3: MIME 組立...");
  const raw = buildRawMime({
    to: opts.to,
    sender: opts.sender,
    subject: opts.subject,
  });
  console.log(`  ✓ MIME size: ${raw.length} bytes (base64url)`);

  if (!opts.send) {
    console.log("---");
    console.log("DRY-RUN: Gmail API messages.send 呼出しはスキップしました。");
    console.log("実送信するには --send を付けて再実行してください。");
    return;
  }

  console.log("Step 4: Gmail API messages.send 実行...");
  const gmail = google.gmail({ version: "v1", auth });
  const response = await gmail.users.messages.send({
    userId: "me", // subject に設定された Group/User として送信
    requestBody: { raw },
  });

  const messageId = response.data.id;
  const threadId = response.data.threadId;

  console.log("---");
  console.log(`✓ 送信成功`);
  console.log(`  messageId: ${messageId}`);
  console.log(`  threadId:  ${threadId}`);
  console.log("");
  console.log("OQ-2 smoke check 結果: PASS");
  console.log("→ Group エイリアスでも DWD subject として gmail.send が機能することを確認");
}

main().catch((err) => {
  console.error("");
  console.error("=== smoke check FAILED ===");
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
    // GaxiosError 形式から reason を取り出して原因の手がかりを出す
    const gax = err as Error & {
      response?: { status?: number; data?: unknown };
    };
    if (gax.response) {
      console.error(`HTTP status: ${gax.response.status}`);
      console.error(`Response data: ${JSON.stringify(gax.response.data, null, 2)}`);
    }
  } else {
    console.error(String(err));
  }
  console.error("");
  console.error("対処:");
  console.error("  - 403 insufficientPermissions: DWD scope 反映待ち (最大 24h)");
  console.error("  - 403 delegationDenied: dxcollege@279279.net への DWD なりすまし不可");
  console.error("                          → SendAs 設定 or 実ユーザー mailbox 化を判断");
  console.error("  - 401: SA キー無効 / Secret Manager 読取り失敗");
  console.error("");
  process.exit(1);
});
