#!/usr/bin/env npx tsx
/**
 * 進捗レポート定期自動配信 dry-run admin SDK CLI (Phase 4 α-7 A3 で薄 wrapper 化)。
 *
 * 純粋ロジックは `services/api/src/services/dispatch/dry-run/progress-report-dry-run.ts`
 * に移管済 (HTTP endpoint と共有)。本 CLI は以下の責務に絞った薄 wrapper:
 *   - Firebase Admin SDK の初期化 (CLI 環境固有: GOOGLE_APPLICATION_CREDENTIALS / ADC)
 *   - service module の呼び出し
 *   - 出力 JSON 書き出し (stdout + artifact file)
 *   - workflow log 向けの summary stderr
 *
 * 出力 JSON 構造は α-7 以前 (本 wrapper 化前) と **1:1 互換** を維持:
 *   - 旧 `DryRunResultCli` 型 = shared-types `ProgressDryRunResult` から `lane` field を除外
 *   - 既存 `progress-report-dry-run-result-*.json` artifact の構造を変えない
 *
 * 完全 read-only:
 *   - Gmail 送信なし
 *   - PDF 実生成なし (cutover smoke `progress-report-smoke.yml` で計測)
 *   - Firestore write なし
 *
 * 使用方法:
 *   # ローカル (ADC 経由)
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *   GOOGLE_CLOUD_PROJECT=lms-279 \
 *   npx tsx scripts/progress-report-dry-run-cli.ts
 *
 *   # workflow_dispatch (WIF 認証)
 *   GitHub Actions UI > Progress Report Dry Run > Run workflow
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク A3
 *   - service module: services/api/src/services/dispatch/dry-run/progress-report-dry-run.ts
 *   - runbook: docs/runbook/dxcollege-progress-report-cutover.md
 *   - 完了通知レーン mirror: scripts/dispatch-dry-run-cli.ts
 */

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

import type { Firestore } from "firebase-admin/firestore";

import { FirestoreDispatchStorage } from "../services/api/src/services/dispatch/firestore-dispatch-storage.js";
import { FirestoreTenantDataLoader } from "../services/api/src/services/dispatch/firestore-tenant-data-loader.js";
import { sanitizeErrorForAudit } from "../services/api/src/services/dispatch/dispatch-error-sanitizer.js";
import {
  runProgressReportDryRun,
  CONSOLE_PROGRESS_DRY_RUN_LOGGER,
  SCALE_TRIGGER_THRESHOLD,
} from "../services/api/src/services/dispatch/dry-run/progress-report-dry-run.js";
import type {
  ProgressDryRunResult,
  ProgressDryRunSkipReason,
  ProgressDryRunTenantSummary,
} from "@lms-279/shared-types";
import {
  GCP_PROJECT_ID,
  SENDER_EMAIL,
  initFirestoreForCli,
} from "./lib/init-firebase-admin.js";

// ============================================================
// 旧 CLI 公開型 (A3 wrapper 化、smoke test との 1:1 互換維持)
// ============================================================
// service module / shared-types に移管済の型を旧 CLI 名で re-export。
// `DryRunResultCli` は旧 CLI 戻り値構造 (lane field なし) を保つため Omit で表現。

export type DryRunSkipReason = ProgressDryRunSkipReason;
export type DryRunTenantSummary = ProgressDryRunTenantSummary;
/**
 * 旧 CLI 戻り値型 (Phase 4 α-7 wrapper 化前と完全互換)。
 * service module の `ProgressDryRunResult` から `lane: "progress"` discriminator を除外したもの。
 */
export type DryRunResultCli = Omit<ProgressDryRunResult, "lane">;

// 環境変数 (GCP_PROJECT_ID / SENDER_EMAIL) と Firebase Admin SDK 初期化は
// scripts/lib/init-firebase-admin.ts に集約 (safe-refactor M1)。
// 旧 `initFirestore()` ローカル定義は撤去。

// ============================================================
// CLI wrapper エントリ (service module 呼出 + lane field 除外で旧互換維持)
// ============================================================

export async function runProgressReportDryRunCli(
  db: Firestore,
  now: Date = new Date(),
): Promise<DryRunResultCli> {
  const storage = new FirestoreDispatchStorage(db);
  const loader = new FirestoreTenantDataLoader(db);
  const result = await runProgressReportDryRun({
    storage,
    loader,
    now,
    logger: CONSOLE_PROGRESS_DRY_RUN_LOGGER,
  });
  // 旧 CLI 出力構造との互換維持: lane field を除外 (smoke test + artifact 構造保持)
  const { lane: _lane, ...legacyShape } = result;
  return legacyShape;
}

// ============================================================
// CLI エントリポイント (旧 main と同等の挙動)
// ============================================================

async function main(): Promise<void> {
  console.error("[progress-report-dry-run-cli] start");
  console.error(`  project: ${GCP_PROJECT_ID}`);
  console.error(`  sender:  ${SENDER_EMAIL}`);
  console.error("");

  const db = initFirestoreForCli();
  const result = await runProgressReportDryRunCli(db);

  // stdout に JSON 出力 (workflow log でも見える)
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  // artifact 用のファイル出力 (workflow から upload-artifact で吸い上げる)
  const ts = result.evaluatedAt.replace(/[:.]/g, "-");
  const outFile = `progress-report-dry-run-result-${ts}.json`;
  writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  console.error(`[progress-report-dry-run-cli] result written: ${outFile}`);
  console.error(
    `[progress-report-dry-run-cli] summary: ${result.totalWouldSendCount} target(s), ` +
      `${result.tenantsScanned} tenant(s) scanned, ` +
      `~${Math.round(result.estimatedDurationMs / 1000)}s estimated`,
  );
  const orphanCount = result.tenantsSummary.filter(
    (s) => s.skipReason === "tenant_doc_not_found",
  ).length;
  if (orphanCount > 0) {
    console.error(
      `[progress-report-dry-run-cli] WARN: tenant_doc_not_found が ${orphanCount} 件。` +
        `subcollection 孤児の可能性があるため確認推奨。`,
    );
  }
  if (result.scaleTriggerExceeded) {
    console.error(
      `[progress-report-dry-run-cli] WARN: scale trigger exceeded ` +
        `(>${SCALE_TRIGGER_THRESHOLD} targets) — Cloud Tasks 移行検討`,
    );
  }
}

// テスト import 時に main() が走らないようにエントリポイント判定
const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainEntry) {
  main().catch((err) => {
    process.exitCode = 1;
    process.stderr.write("\n=== progress-report-dry-run-cli FAILED ===\n");
    process.stderr.write(`Error: ${sanitizeErrorForAudit(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(`Stack: ${err.stack}\n`);
    }
  });
}
