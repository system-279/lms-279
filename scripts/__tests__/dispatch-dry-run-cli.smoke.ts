#!/usr/bin/env npx tsx
/**
 * `scripts/dispatch-dry-run-cli.ts` の module-load + 型 sanity smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため、node:assert で最低限の回帰検知。
 *   - 本 CLI は Firestore 統合 (副作用) が中心のため Unit Test は最小に留め、
 *     実機検証は workflow_dispatch + dry-run 出力 JSON で行う方針。
 *   - test 経由の import で main() が走らないこと (isMainEntry guard) が回帰時に
 *     最も発覚しやすいバグなので、import 自体が副作用を起こさないことを確認する。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/dispatch-dry-run-cli.smoke.ts
 */

import assert from "node:assert/strict";

import {
  runDryRunCli,
  type DryRunMimePreview,
  type DryRunResultCli,
  type DryRunTargetCli,
  type DryRunTenantSummary,
} from "../dispatch-dry-run-cli.ts";

// --- export sanity: runDryRunCli が関数として import できる ---
{
  assert.equal(typeof runDryRunCli, "function", "runDryRunCli must be a function");
  assert.equal(
    runDryRunCli.length,
    1,
    "runDryRunCli should take a single Firestore arg",
  );
}

// --- 型 sanity: 公開された型が DTO として構築可能 ---
{
  const preview: DryRunMimePreview = {
    from: "DXcollege運営スタッフ <dxcollege@279279.net>",
    to: "user@example.com",
    cc: ["owner@tenant.example"],
    subject: "【DXcollege】受講修了のお知らせ",
    body: "山田太郎 様\n\n受講お疲れ様でした。\n\n---\nDXcollege運営スタッフ\n",
  };
  const target: DryRunTargetCli = {
    tenantId: "tenant-a",
    userId: "user-1",
    userEmail: "user@example.com",
    userName: "山田太郎",
    courseIdsSnapshot: ["c1", "c2"],
    mimePreview: preview,
  };
  const summary: DryRunTenantSummary = {
    tenantId: "tenant-a",
    skipped: false,
    usersScanned: 10,
    eligibleCount: 1,
  };
  const result: DryRunResultCli = {
    evaluatedAt: "2026-05-23T12:00:00.000Z",
    settingsLoaded: true,
    settingsSnapshot: {
      enabled: false,
      scheduleDaysOfWeek: [1],
      scheduleHourJst: 9,
      signatureName: "DXcollege運営スタッフ",
      completionMessageBodyLength: 50,
    },
    tenantsScanned: 1,
    tenantsSummary: [summary],
    wouldNotifyCount: 1,
    wouldNotify: [target],
  };

  // 構造 invariants
  assert.equal(result.wouldNotifyCount, result.wouldNotify.length);
  assert.ok(result.tenantsSummary.every((s) => s.eligibleCount >= 0));
  assert.match(target.mimePreview.from, /<.*@.*>$/, "from header MUST contain angle-bracketed email");
}

// --- skipReason の lifecycle: skipped=true の時のみ意味を持つ ---
{
  const skipped: DryRunTenantSummary = {
    tenantId: "tenant-b",
    skipped: true,
    skipReason: "tenant_completion_notification_disabled",
    usersScanned: 0,
    eligibleCount: 0,
  };
  assert.equal(skipped.usersScanned, 0, "skipped tenant has 0 users scanned");
  assert.equal(skipped.eligibleCount, 0, "skipped tenant has 0 eligible");
}

// --- 副作用なし import sanity: 本 file 読込時点で initFirestore() / main() が呼ばれていないこと ---
// → main() が走っていれば firebase-admin の initializeApp が走り、credentials 不足で throw する。
// 本テストがここまで例外なく到達できているということは、isMainEntry guard が機能している証拠。
// (assert は不要、ここまで到達できたこと自体が test の合格条件)

console.log("dispatch-dry-run-cli.smoke.ts: all structural assertions passed");
