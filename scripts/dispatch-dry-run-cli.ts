#!/usr/bin/env npx tsx
/**
 * DXcollege 自動完了通知 dry-run admin SDK CLI (Phase 4 α-7 A3 で薄 wrapper 化)。
 *
 * 純粋ロジックは `services/api/src/services/dispatch/dry-run/completion-notification-dry-run.ts`
 * に移管済 (HTTP endpoint と共有)。本 CLI は以下の責務に絞った薄 wrapper:
 *   - Firebase Admin SDK の初期化 (CLI 環境固有: GOOGLE_APPLICATION_CREDENTIALS / ADC)
 *   - service module の呼び出し
 *   - 出力 JSON 書き出し (stdout + artifact file)
 *   - workflow log 向けの summary stderr
 *
 * 出力 JSON 構造は α-7 以前 (本 wrapper 化前) と **1:1 互換** を維持:
 *   - 旧 `DryRunResultCli` 型 = shared-types `CompletionDryRunResult` から `lane` field を除外
 *   - 既存 `dispatch-dry-run-result-*.json` artifact の構造を変えない
 *
 * 完全 read-only:
 *   - Gmail 送信なし
 *   - Firestore write なし
 *
 * 使用方法:
 *   # ローカル (ADC 経由)
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *   GOOGLE_CLOUD_PROJECT=lms-279 \
 *   npx tsx scripts/dispatch-dry-run-cli.ts
 *
 *   # workflow_dispatch (WIF 認証)
 *   GitHub Actions UI > Dispatch Dry Run > Run workflow
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク A3
 *   - service module: services/api/src/services/dispatch/dry-run/completion-notification-dry-run.ts
 *   - playbook: docs/runbook/dxcollege-completion-notification-cutover.md Step 5
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
import { FirestoreTenantDataLoader } from "../services/api/src/services/dispatch/firestore-tenant-data-loader.js";
import { sanitizeErrorForAudit } from "../services/api/src/services/dispatch/dispatch-error-sanitizer.js";
import { runCompletionNotificationDryRun } from "../services/api/src/services/dispatch/dry-run/completion-notification-dry-run.js";
import type {
  CompletionDryRunResult,
  CompletionDryRunTarget,
  CompletionDryRunTenantSummary,
  DryRunMimePreview as SharedDryRunMimePreview,
} from "@lms-279/shared-types";

// ============================================================
// 旧 CLI 公開型 (A3 wrapper 化、smoke test との 1:1 互換維持)
// ============================================================
// service module / shared-types に移管済の型を旧 CLI 名で re-export。

export type DryRunMimePreview = SharedDryRunMimePreview;
export type DryRunTargetCli = CompletionDryRunTarget;
export type DryRunTenantSummary = CompletionDryRunTenantSummary;
/**
 * 旧 CLI 戻り値型 (Phase 4 α-7 wrapper 化前と完全互換)。
 * service module の `CompletionDryRunResult` から `lane: "completion"` discriminator を除外。
 */
export type DryRunResultCli = Omit<CompletionDryRunResult, "lane">;

// ============================================================
// 環境変数
// ============================================================

const GCP_PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "lms-279";
const SENDER_EMAIL = process.env.DXCOLLEGE_SENDER_EMAIL ?? "dxcollege@279279.net";

// ============================================================
// Firebase Admin SDK 初期化 (progress-report-dry-run-cli と同パターン)
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
// CLI wrapper エントリ (service module 呼出 + lane field 除外で旧互換維持)
// ============================================================

export async function runDryRunCli(db: Firestore): Promise<DryRunResultCli> {
  const storage = new FirestoreDispatchStorage(db);
  const loader = new FirestoreTenantDataLoader(db);
  const result = await runCompletionNotificationDryRun({
    storage,
    loader,
    senderEmail: SENDER_EMAIL,
    now: new Date(),
  });
  // 旧 CLI 出力構造との互換維持: lane field を除外 (smoke test + artifact 構造保持)
  const { lane: _lane, ...legacyShape } = result;
  return legacyShape;
}

// ============================================================
// CLI エントリポイント (旧 main と同等の挙動)
// ============================================================

async function main(): Promise<void> {
  console.error("[dispatch-dry-run-cli] start");
  console.error(`  project: ${GCP_PROJECT_ID}`);
  console.error(`  sender:  ${SENDER_EMAIL}`);
  console.error("");

  const db = initFirestore();
  const result = await runDryRunCli(db);

  // stdout に JSON 出力 (workflow log でも見える)
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  // artifact 用のファイル出力 (workflow から upload-artifact で吸い上げる)
  const ts = result.evaluatedAt.replace(/[:.]/g, "-");
  const outFile = `dispatch-dry-run-result-${ts}.json`;
  writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  console.error(`[dispatch-dry-run-cli] result written: ${outFile}`);
  console.error(
    `[dispatch-dry-run-cli] summary: ${result.wouldNotifyCount} target(s), ` +
      `${result.tenantsScanned} tenant(s) scanned`,
  );
}

// テスト import 時に main() が走らないようにエントリポイント判定する。
// `pathToFileURL` で URL encode 差 (空白 / 非 ASCII path) を吸収する。
const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainEntry) {
  main().catch((err) => {
    process.exitCode = 1;
    process.stderr.write("\n=== dispatch-dry-run-cli FAILED ===\n");
    process.stderr.write(`Error: ${sanitizeErrorForAudit(err)}\n`);
    if (err instanceof Error && err.stack) {
      // stack は workflow log で開発者にのみ見える (Cloud Build 等で漏洩しない構成前提)
      process.stderr.write(`Stack: ${err.stack}\n`);
    }
  });
}
