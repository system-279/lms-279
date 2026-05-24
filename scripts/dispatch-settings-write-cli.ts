#!/usr/bin/env npx tsx
/**
 * DXcollege 自動完了通知 dispatch-settings 暫定書込 admin SDK CLI (テスト段階限定)。
 *
 * 目的:
 *   Phase 8 cutover のテスト段階で AI が `super_dispatch_settings/global` doc を
 *   admin SDK 経由で upsert する。`/super/dispatch-settings` UI ボタン (撤廃予定)
 *   を経由せず、本番 ID Token 取得経路を整備せずに、Firestore 直書きで設定する。
 *
 *   本 CLI は **テスト段階限定** の暫定機能:
 *     - 本番運用開始時はスーパー管理者が Web UI から自分の運用方針で設定し直す
 *     - その時点で本 CLI による暫定値は上書きされる (UI 経由 = `updateDispatchSettings`
 *       で version conflict 起こさないよう本 CLI も同じ method を使う)
 *     - 撤廃候補は PR-B 以降の整理対象
 *
 *   安全機構:
 *     - `enabled` は input から受け取らず常に **false** (kill switch 強制)。
 *       テスト段階の AI 操作で実送信が走らないことを構造的に保証する。
 *     - 既存 dispatch-storage.ts の `updateDispatchSettings` を使う (本番 logic と
 *       楽観的ロック / version increment / merge 動作を完全同期)
 *     - 入力検証: scheduleDaysOfWeek 各 0-6 / scheduleHourJst 0-23 /
 *       signatureName 1-100 chars / completionMessageBody 1-4000 chars
 *
 * 動作:
 *   1. Firestore admin SDK 初期化 (WIF or ローカル SA key)
 *   2. CLI 引数を parse + validate (CliParseError で throw)
 *   3. 既存 doc を read (version 取得)
 *   4. updateDispatchSettings で upsert (expectedVersion=current.version ?? 0)
 *   5. version_conflict なら警告して exit 1
 *   6. 結果 (settings snapshot) を JSON で stdout + ファイル出力
 *
 * 使用方法:
 *   # workflow_dispatch (WIF 認証、推奨)
 *   GitHub Actions UI > Dispatch Settings Write > Run workflow
 *
 *   # ローカル (ADC 経由、開発検証用)
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *   GOOGLE_CLOUD_PROJECT=lms-279 \
 *   npx tsx scripts/dispatch-settings-write-cli.ts \
 *     --schedule-days-of-week=1 \
 *     --schedule-hour-jst=9 \
 *     --signature-name='DXcollege運営スタッフ' \
 *     --completion-message-body='受講お疲れ様でした...'
 *
 * 関連:
 *   - 設計仕様書: docs/specs/2026-05-20-completion-notification-design.md §4.1.1 (DispatchSettings)
 *   - playbook: docs/runbook/dxcollege-completion-notification-cutover.md Step 1 (AI 代替)
 *   - 既存 API endpoint (撤廃予定): services/api/src/routes/super/dispatch-settings.ts
 *   - 既存 update 関数: services/api/src/services/dispatch/firestore-dispatch-storage.ts
 */

import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  applicationDefault,
  cert,
  initializeApp,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { FirestoreDispatchStorage } from "../services/api/src/services/dispatch/firestore-dispatch-storage.js";
import { sanitizeErrorForAudit } from "../services/api/src/services/dispatch/dispatch-error-sanitizer.js";

// ============================================================
// 定数 / バリデーション
// ============================================================

const DEFAULT_UPDATED_BY = "ai-test-cli@279279.net";
const SIGNATURE_MAX = 100;
const BODY_MAX = 4000;
const HOUR_MIN = 0;
const HOUR_MAX = 23;
const DAY_MIN = 0;
const DAY_MAX = 6;

// ============================================================
// 型定義
// ============================================================

export interface CliOptions {
  scheduleDaysOfWeek: number[];
  scheduleHourJst: number;
  signatureName: string;
  completionMessageBody: string;
  /** 更新者 email (audit log 用、未指定なら ai-test-cli@279279.net) */
  updatedBy: string;
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
  "Usage: dispatch-settings-write-cli.ts " +
  "--schedule-days-of-week=<csv 0-6> " +
  "--schedule-hour-jst=<0-23> " +
  "--signature-name=<string> " +
  "--completion-message-body=<string> " +
  "[--updated-by=<email>]";

// ============================================================
// CLI 引数 parse + validate
// ============================================================

export function parseArgs(argv: string[]): CliOptions {
  let scheduleDaysOfWeekRaw: string | null = null;
  let scheduleHourJstRaw: string | null = null;
  let signatureName: string | null = null;
  let completionMessageBody: string | null = null;
  let updatedBy: string = DEFAULT_UPDATED_BY;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--schedule-days-of-week=")) {
      scheduleDaysOfWeekRaw = arg.slice("--schedule-days-of-week=".length).trim();
    } else if (arg.startsWith("--schedule-hour-jst=")) {
      scheduleHourJstRaw = arg.slice("--schedule-hour-jst=".length).trim();
    } else if (arg.startsWith("--signature-name=")) {
      signatureName = arg.slice("--signature-name=".length);
    } else if (arg.startsWith("--completion-message-body=")) {
      completionMessageBody = arg.slice("--completion-message-body=".length);
    } else if (arg.startsWith("--updated-by=")) {
      updatedBy = arg.slice("--updated-by=".length).trim();
    } else if (arg === "--help" || arg === "-h") {
      throw new CliParseError(HELP_TEXT, 0);
    } else {
      throw new CliParseError(`Unknown argument: ${arg}`, 2);
    }
  }

  if (scheduleDaysOfWeekRaw === null) {
    throw new CliParseError("FATAL: --schedule-days-of-week=<csv> is required", 2);
  }
  if (scheduleHourJstRaw === null) {
    throw new CliParseError("FATAL: --schedule-hour-jst=<0-23> is required", 2);
  }
  if (signatureName === null) {
    throw new CliParseError("FATAL: --signature-name=<string> is required", 2);
  }
  if (completionMessageBody === null) {
    throw new CliParseError("FATAL: --completion-message-body=<string> is required", 2);
  }

  // --schedule-days-of-week=1,3,5 → [1,3,5]
  const scheduleDaysOfWeek = parseScheduleDaysOfWeek(scheduleDaysOfWeekRaw);

  const scheduleHourJst = Number.parseInt(scheduleHourJstRaw, 10);
  if (
    !Number.isFinite(scheduleHourJst) ||
    scheduleHourJst < HOUR_MIN ||
    scheduleHourJst > HOUR_MAX
  ) {
    throw new CliParseError(
      `FATAL: --schedule-hour-jst must be integer in [${HOUR_MIN}, ${HOUR_MAX}] (got: ${scheduleHourJstRaw})`,
      2,
    );
  }

  if (signatureName.length === 0 || signatureName.length > SIGNATURE_MAX) {
    throw new CliParseError(
      `FATAL: --signature-name length must be in [1, ${SIGNATURE_MAX}] (got: ${signatureName.length})`,
      2,
    );
  }
  if (completionMessageBody.length === 0 || completionMessageBody.length > BODY_MAX) {
    throw new CliParseError(
      `FATAL: --completion-message-body length must be in [1, ${BODY_MAX}] (got: ${completionMessageBody.length})`,
      2,
    );
  }

  return {
    scheduleDaysOfWeek,
    scheduleHourJst,
    signatureName,
    completionMessageBody,
    updatedBy,
  };
}

/**
 * "1,3,5" → [1, 3, 5]。
 * 空文字 / 重複 / 範囲外 / 非数値は CliParseError。空配列も拒否 (配信不可能な
 * 設定を防止)。
 */
export function parseScheduleDaysOfWeek(raw: string): number[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CliParseError(
      "FATAL: --schedule-days-of-week must contain at least one day (0-6, comma separated)",
      2,
    );
  }
  const parts = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new CliParseError(
      "FATAL: --schedule-days-of-week must contain at least one day",
      2,
    );
  }
  const result: number[] = [];
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < DAY_MIN || n > DAY_MAX) {
      throw new CliParseError(
        `FATAL: --schedule-days-of-week entries must be integers in [${DAY_MIN}, ${DAY_MAX}] (got: ${part})`,
        2,
      );
    }
    if (!result.includes(n)) result.push(n);
  }
  // sorted (deterministic order)
  result.sort((a, b) => a - b);
  return result;
}

// ============================================================
// 環境変数 / 定数
// ============================================================

const GCP_PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "lms-279";
const SENDER_EMAIL = process.env.DXCOLLEGE_SENDER_EMAIL ?? "dxcollege@279279.net";

// ============================================================
// Firebase Admin SDK 初期化 (PR-A と同じパターン)
// ============================================================

function initFirestore(): Firestore {
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

// ============================================================
// メイン upsert ロジック
// ============================================================

export interface WriteResult {
  evaluatedAt: string;
  /** "created" (新規 doc) / "updated" (既存 doc) / "conflict" (version 競合) */
  outcome: "created" | "updated" | "conflict";
  previousVersion: number | null;
  newVersion: number | null;
  /** 書き込んだ (or 競合時の現状) settings snapshot */
  settings: {
    enabled: boolean;
    scheduleDaysOfWeek: number[];
    scheduleHourJst: number;
    signatureName: string;
    completionMessageBodyLength: number;
    senderEmail: string;
    version: number;
  } | null;
}

export async function runWriteCli(
  db: Firestore,
  opts: CliOptions,
  now: Date,
): Promise<WriteResult> {
  const storage = new FirestoreDispatchStorage(db);

  // 既存 doc を read (version 取得)
  const current = await storage.getDispatchSettings();
  const expectedVersion = current?.version ?? 0;

  // upsert
  const outcome = await storage.updateDispatchSettings({
    expectedVersion,
    enabled: false, // 強制 false (kill switch、テスト段階の AI 操作で実送信させない)
    scheduleDaysOfWeek: opts.scheduleDaysOfWeek,
    scheduleHourJst: opts.scheduleHourJst,
    signatureName: opts.signatureName,
    completionMessageBody: opts.completionMessageBody,
    senderEmail: SENDER_EMAIL,
    updatedBy: opts.updatedBy,
    updatedAt: now.toISOString(),
  });

  const evaluatedAt = now.toISOString();

  if (!outcome.updated) {
    // version_conflict
    return {
      evaluatedAt,
      outcome: "conflict",
      previousVersion: current?.version ?? null,
      newVersion: null,
      settings: outcome.current
        ? {
            enabled: outcome.current.enabled,
            scheduleDaysOfWeek: outcome.current.scheduleDaysOfWeek,
            scheduleHourJst: outcome.current.scheduleHourJst,
            signatureName: outcome.current.signatureName,
            completionMessageBodyLength: outcome.current.completionMessageBody.length,
            senderEmail: outcome.current.senderEmail,
            version: outcome.current.version,
          }
        : null,
    };
  }

  return {
    evaluatedAt,
    outcome: current === null ? "created" : "updated",
    previousVersion: current?.version ?? null,
    newVersion: outcome.settings.version,
    settings: {
      enabled: outcome.settings.enabled,
      scheduleDaysOfWeek: outcome.settings.scheduleDaysOfWeek,
      scheduleHourJst: outcome.settings.scheduleHourJst,
      signatureName: outcome.settings.signatureName,
      completionMessageBodyLength: outcome.settings.completionMessageBody.length,
      senderEmail: outcome.settings.senderEmail,
      version: outcome.settings.version,
    },
  };
}

// ============================================================
// CLI エントリポイント
// ============================================================

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof CliParseError) {
      if (err.exitCode === 0) console.log(err.message);
      else console.error(err.message);
      process.exit(err.exitCode);
    }
    throw err;
  }

  console.error("[dispatch-settings-write-cli] start");
  console.error(`  project:  ${GCP_PROJECT_ID}`);
  console.error(`  sender:   ${SENDER_EMAIL}`);
  console.error(`  enabled:  false (forced kill switch, test phase)`);
  console.error(`  days:     [${opts.scheduleDaysOfWeek.join(",")}]`);
  console.error(`  hour:     ${opts.scheduleHourJst} JST`);
  console.error(`  signature length: ${opts.signatureName.length}`);
  console.error(`  body length:      ${opts.completionMessageBody.length}`);
  console.error(`  updatedBy:        ${opts.updatedBy}`);
  console.error("");

  const db = initFirestore();
  const result = await runWriteCli(db, opts, new Date());

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  const ts = result.evaluatedAt.replace(/[:.]/g, "-");
  const outFile = `dispatch-settings-write-result-${ts}.json`;
  writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  console.error(`[dispatch-settings-write-cli] result written: ${outFile}`);
  console.error(
    `[dispatch-settings-write-cli] outcome=${result.outcome} ` +
      `prevVersion=${result.previousVersion ?? "null"} ` +
      `newVersion=${result.newVersion ?? "null"}`,
  );

  if (result.outcome === "conflict") {
    process.exitCode = 1;
    console.error(
      "[dispatch-settings-write-cli] version_conflict: 同時編集を検出。current settings を確認して再実行してください。",
    );
  }
}

// テスト import 時に main() が走らないようにエントリポイント判定する (PR-A と同じパターン)。
const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainEntry) {
  main().catch((err) => {
    process.exitCode = 1;
    process.stderr.write("\n=== dispatch-settings-write-cli FAILED ===\n");
    process.stderr.write(`Error: ${sanitizeErrorForAudit(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(`Stack: ${err.stack}\n`);
    }
  });
}
