#!/usr/bin/env npx tsx
/**
 * DXcollege 自動完了通知 SendAs 送信 smoke check スクリプト (ADR-037 採用後)。
 *
 * 目的:
 *   ADR-037 案 X (SendAs) 採用に伴い、DWD subject = 実 mailbox (`system@279279.net`)、
 *   MIME From = `dxcollege@279279.net` (SendAs 経由で偽装) の構成で
 *   `gmail.users.messages.send` が成功し、受信者の From ヘッダが `dxcollege@279279.net`
 *   として表示されるかを実機検証する。
 *
 *   経緯: OQ-2 smoke (2026-05-21) で Group エイリアスへの DWD impersonation 不可と確定し、
 *   ADR-037 で SendAs 案を採用。本 smoke は SendAs 経路の正当性を検証する Phase 8 cutover の
 *   gating step。
 *
 * 動作モード:
 *   --dry-run (既定): DWD 認証 + JWT 生成 + MIME 組立まで実行、Gmail API 呼出しは行わない
 *   --send: 上記に加え、実際に Gmail API で送信する
 *
 * 安全機構:
 *   - --dry-run 既定 (--send で実送信)
 *   - --to (必須): 送信先 email、明示指定。誤入力防止。
 *   - --subject (任意): 件名、既定 "[smoke] DXcollege 自動完了通知 SendAs smoke check"
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
 *   - ADR-037: docs/adr/ADR-037-completion-notification-sender-impersonation.md (SendAs 採用)
 *   - 設計仕様書: docs/specs/2026-05-20-completion-notification-design.md §8.1, OQ-X
 *   - 実装計画: docs/specs/2026-05-20-completion-notification-impl-plan.md Phase 0 / Phase 8
 *   - 既存 DWD 基盤: services/api/src/services/google-auth.ts
 */

import { pathToFileURL } from "node:url";

import { google } from "googleapis";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { sanitizeErrorForAudit } from "../services/api/src/services/dispatch/dispatch-error-sanitizer.js";

const GCP_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "lms-279";
const DWD_SECRET_NAME = `projects/${GCP_PROJECT_ID}/secrets/dwd-workspace-key/versions/latest`;
// ADR-037 で導入された 2 引数構造 (DWD subject ≠ MIME From) と一致させる:
//   DXCOLLEGE_DISPATCH_SUBJECT: DWD impersonation 対象 (実 mailbox、例 system@279279.net)
//   DXCOLLEGE_SENDER_EMAIL:     MIME From ヘッダ (SendAs 経由で偽装、例 dxcollege@279279.net)
// 設計仕様書 NFR-8 / FR-5 改訂 / 実装計画 Phase 7 で Cloud Run env に追加済。
// ローカル smoke では引数で上書き可能。
const DEFAULT_SUBJECT_EMAIL = process.env.DXCOLLEGE_DISPATCH_SUBJECT ?? "system@279279.net";
const DEFAULT_SENDER = process.env.DXCOLLEGE_SENDER_EMAIL ?? "dxcollege@279279.net";
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// ============================================================
// CLI 引数パース
// ============================================================

export interface CliOptions {
  to: string;
  subject: string;
  /** DWD impersonation 対象 (実 mailbox)。ADR-037 で MIME From と分離。 */
  subjectEmail: string;
  /** MIME From ヘッダ (SendAs 経由で偽装される表示用 From)。 */
  sender: string;
  send: boolean; // true なら実送信、false (既定) なら dry-run
}

export class CliParseError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 0 | 2,
  ) {
    super(message);
    this.name = "CliParseError";
  }
}

const HELP_TEXT =
  "Usage: smoke-dwd-gmail-send.ts --to=<email> " +
  "[--subject=...] [--subject-email=<dwd-subject-mailbox>] [--sender=<mime-from>] [--send|--dry-run]";

/**
 * argv[2:] を解釈して CliOptions を返す。
 * 失敗時は CliParseError を throw (exitCode = 2)、--help は exitCode = 0 を持つ CliParseError。
 * CLI から呼ぶ側で process.exit / console.error にマッピングする。
 */
export function parseArgs(argv: string[]): CliOptions {
  let to: string | null = null;
  let subject = "[smoke] DXcollege 自動完了通知 SendAs smoke check";
  let subjectEmail = DEFAULT_SUBJECT_EMAIL;
  let sender = DEFAULT_SENDER;
  let send = false;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length).trim();
    } else if (arg.startsWith("--subject-email=")) {
      // 順序注意: "--subject-email=" は "--subject=" より先に判定する
      // (前方一致で "--subject=" にも match してしまうため)
      subjectEmail = arg.slice("--subject-email=".length).trim();
    } else if (arg.startsWith("--subject=")) {
      subject = arg.slice("--subject=".length).trim();
    } else if (arg.startsWith("--sender=")) {
      sender = arg.slice("--sender=".length).trim();
    } else if (arg === "--send") {
      send = true;
    } else if (arg === "--dry-run") {
      send = false;
    } else if (arg === "--help" || arg === "-h") {
      throw new CliParseError(HELP_TEXT, 0);
    } else {
      throw new CliParseError(`Unknown argument: ${arg}`, 2);
    }
  }

  if (!to) {
    throw new CliParseError(
      "FATAL: --to=<email> is required (送信先指定なしでは smoke 不可)",
      2,
    );
  }

  // 簡易バリデーション (smoke なので最小限)
  if (!EMAIL_REGEX.test(to)) {
    throw new CliParseError(`FATAL: --to does not look like a valid email: ${to}`, 2);
  }
  if (!EMAIL_REGEX.test(subjectEmail)) {
    throw new CliParseError(
      `FATAL: --subject-email does not look like a valid email: ${subjectEmail}`,
      2,
    );
  }
  if (!EMAIL_REGEX.test(sender)) {
    throw new CliParseError(
      `FATAL: --sender does not look like a valid email: ${sender}`,
      2,
    );
  }

  return { to, subject, subjectEmail, sender, send };
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
  subjectEmail: string;
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
    "This is a SendAs smoke test for the DXcollege completion notification system (ADR-037).",
    "If you received this with the From header below, the SendAs send path is working:",
    `  - DWD subject mailbox (Sent folder owner): ${opts.subjectEmail}`,
    `  - MIME From (受信者表示、SendAs 経由偽装):  ${opts.sender}`,
    "",
    "Related: docs/adr/ADR-037-completion-notification-sender-impersonation.md",
  ].join("\r\n");

  return Buffer.from(body, "utf-8").toString("base64url");
}

// ============================================================
// メイン
// ============================================================

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof CliParseError) {
      if (err.exitCode === 0) {
        console.log(err.message);
      } else {
        console.error(err.message);
      }
      process.exit(err.exitCode);
    }
    throw err;
  }

  console.log(`Mode: ${opts.send ? "SEND (実送信)" : "DRY-RUN (Gmail API 呼出しなし)"}`);
  console.log(`DWD subject (impersonation 対象 mailbox): ${opts.subjectEmail}`);
  console.log(`MIME From (受信者表示、SendAs 経由):     ${opts.sender}`);
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
    subject: opts.subjectEmail, // ADR-037: 実 mailbox を impersonation
  });
  await auth.authorize();
  console.log("  ✓ JWT 認可成功 (DWD scope 反映済み)");

  console.log("Step 3: MIME 組立...");
  const raw = buildRawMime({
    to: opts.to,
    sender: opts.sender, // MIME From は SendAs で偽装される表示用
    subjectEmail: opts.subjectEmail,
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
    userId: "me", // impersonation 対象 mailbox の Sent folder に蓄積
    requestBody: { raw },
  });

  const messageId = response.data.id;
  const threadId = response.data.threadId;

  console.log("---");
  console.log(`✓ 送信成功`);
  console.log(`  messageId: ${messageId}`);
  console.log(`  threadId:  ${threadId}`);
  console.log("");
  console.log("SendAs smoke check 結果: PASS (API 受理)");
  console.log("→ 受信側で From ヘッダが " + opts.sender + " として表示されるか目視確認すること (ADR-037 OQ-X)");
}

// テスト import 時に main() が走らないようにエントリポイント判定する。
// `pathToFileURL` を使うのは、パスに空白 / `#` / 非 ASCII 文字が含まれるとき
// `import.meta.url` が URL encode されるのに対し、生パス比較では一致しなくなる
// (CLI 実行時に silent skip) のを防ぐため (codex review 2026-05-23 PR #486 指摘)。
// `process.argv[1]` が undefined な実行 (node -e 等) では false に倒す。
const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainEntry) main().catch((err) => {
  // PR #442 review Critical 3 対応:
  //   workflow log は organization 内で閲覧可能なため、raw response.data を吐くと
  //   PII (受講者 email / access token / API key 等) が漏れる。
  //   sanitizeErrorForAudit を通してから出力する。
  process.exitCode = 1;
  process.stderr.write("\n=== smoke check FAILED ===\n");

  const sanitizedMessage = sanitizeErrorForAudit(err);
  process.stderr.write(`Error: ${sanitizedMessage}\n`);

  // 安全部分のみ個別に抽出 (status / code / reason)。
  // response.data 全体は dump しない (PII 漏洩リスク、Critical 3)。
  const gax = err as Error & {
    code?: unknown;
    response?: {
      status?: number;
      data?: { error?: { errors?: Array<{ reason?: unknown }> } };
    };
  };
  if (typeof gax.code === "string") {
    process.stderr.write(`Error code: ${gax.code}\n`);
  }
  if (gax.response?.status !== undefined) {
    process.stderr.write(`HTTP status: ${gax.response.status}\n`);
  }
  const reasons = gax.response?.data?.error?.errors;
  if (Array.isArray(reasons)) {
    const reasonList = reasons
      .map((entry) => (typeof entry.reason === "string" ? entry.reason : null))
      .filter((r): r is string => r !== null);
    if (reasonList.length > 0) {
      process.stderr.write(`Reasons: ${reasonList.join(", ")}\n`);
    }
  }

  process.stderr.write("\n対処 (ADR-037 採用後):\n");
  process.stderr.write("  - 403 insufficientPermissions: DWD scope 反映待ち (最大 24h)\n");
  process.stderr.write(
    "  - 401 unauthorized_client: --subject-email の mailbox が Group エイリアス\n",
  );
  process.stderr.write(
    "                              → 実 mailbox を指定すること (ADR-037 §smoke 検証ログ参照)\n",
  );
  process.stderr.write(
    "  - 400 invalidArgument / SendAs not configured: --sender 表示用 From が --subject-email\n",
  );
  process.stderr.write(
    "                              mailbox の SendAs に未登録\n",
  );
  process.stderr.write(
    "                              → 設計仕様書 §8.2.2 / ADR-037 §実装方針 4 の手順を実施\n",
  );
  process.stderr.write("  - 401: SA キー無効 / Secret Manager 読取り失敗\n\n");
});
