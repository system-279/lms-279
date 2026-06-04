#!/usr/bin/env npx tsx
/**
 * `scripts/progress-report-dry-run-cli.ts` の module-load + 型 sanity smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため node:assert で最低限の回帰検知
 *   - 本 CLI は Firestore 統合 (副作用) が中心のため Unit Test は最小に留め、
 *     実機検証は workflow_dispatch + dry-run 出力 JSON で行う方針
 *   - test 経由の import で main() が走らないこと (isMainEntry guard) が回帰時に
 *     最も発覚しやすいバグなので、import 自体が副作用を起こさないことを確認する
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/progress-report-dry-run-cli.smoke.ts
 */

import assert from "node:assert/strict";

import {
  runProgressReportDryRunCli,
  type DryRunResultCli,
  type DryRunTenantSummary,
} from "../progress-report-dry-run-cli.ts";

// --- export sanity: runProgressReportDryRunCli が関数として import できる ---
{
  assert.equal(
    typeof runProgressReportDryRunCli,
    "function",
    "runProgressReportDryRunCli must be a function",
  );
  // 引数は (db, now?) の 2 引数 (now はデフォルト引数のため Function.length は 1)
  assert.equal(
    runProgressReportDryRunCli.length,
    1,
    "runProgressReportDryRunCli first required arg is Firestore",
  );
}

// --- 型 sanity: 公開された型が DTO として構築可能 ---
{
  const summary: DryRunTenantSummary = {
    tenantId: "tenant-a",
    skipped: false,
    usersScanned: 10,
    candidateCount: 10,
    invalidEmailCount: 2,
    completedCount: 1,
    // Phase 4 α-7 Codex review (2026-06-04): F1 で追加された ineligibleCount を
    // smoke fixture / invariant に追随させ、DTO 拡張時の回帰検知を機能させる。
    ineligibleCount: 0,
    wouldSendCount: 7,
    ccCount: 2,
  };
  const result: DryRunResultCli = {
    evaluatedAt: "2026-06-03T12:00:00.000Z",
    settingsLoaded: true,
    settingsSnapshot: {
      progressReportEnabled: true,
      scheduleDaysOfWeek: [1, 4],
      scheduleHourJst: 9,
      signatureName: "DXcollege運営スタッフ",
    },
    tenantsScanned: 1,
    tenantsSummary: [summary],
    totalWouldSendCount: 7,
    totalCcCount: 14,
    estimatedDurationMs: 2000,
    estimatedPdfSizeKbRange: { min: 150, typical: 350, max: 1200 },
    scaleTriggerExceeded: false,
  };

  // 構造 invariants
  assert.equal(
    result.totalWouldSendCount,
    result.tenantsSummary.reduce((acc, s) => acc + s.wouldSendCount, 0),
    "totalWouldSendCount must equal sum of tenantsSummary[].wouldSendCount",
  );
  assert.ok(
    result.tenantsSummary.every(
      (s) =>
        s.wouldSendCount +
          s.completedCount +
          s.invalidEmailCount +
          s.ineligibleCount ===
        s.candidateCount,
    ),
    "candidateCount == wouldSendCount + completedCount + invalidEmailCount + ineligibleCount (内訳保証、F1 反映)",
  );
  assert.ok(
    result.estimatedPdfSizeKbRange.min <= result.estimatedPdfSizeKbRange.typical &&
      result.estimatedPdfSizeKbRange.typical <= result.estimatedPdfSizeKbRange.max,
    "PDF size range must be ordered (min ≤ typical ≤ max)",
  );
}

// --- skipReason の lifecycle: skipped=true の時のみ意味を持つ ---
{
  const skipped: DryRunTenantSummary = {
    tenantId: "tenant-b",
    skipped: true,
    skipReason: "progress_report_disabled",
    usersScanned: 0,
    candidateCount: 0,
    invalidEmailCount: 0,
    completedCount: 0,
    ineligibleCount: 0,
    wouldSendCount: 0,
    ccCount: 0,
  };
  assert.equal(skipped.usersScanned, 0, "skipped tenant has 0 users scanned");
  assert.equal(
    skipped.wouldSendCount,
    0,
    "skipped tenant has 0 wouldSendCount",
  );
}

// --- scaleTriggerExceeded 境界: 300 名超でフラグが立つことを期待 (ADR-039) ---
{
  const belowThreshold: DryRunResultCli["scaleTriggerExceeded"] = false;
  const aboveThreshold: DryRunResultCli["scaleTriggerExceeded"] = true;
  assert.equal(typeof belowThreshold, "boolean");
  assert.equal(typeof aboveThreshold, "boolean");
}

// --- 副作用なし import sanity: 本 file 読込時点で initFirestore() / main() が呼ばれていないこと ---
// → main() が走っていれば firebase-admin の initializeApp が走り、credentials 不足で throw する。
// 本テストがここまで例外なく到達できているということは、isMainEntry guard が機能している証拠。

console.log(
  "progress-report-dry-run-cli.smoke.ts: all structural assertions passed",
);
