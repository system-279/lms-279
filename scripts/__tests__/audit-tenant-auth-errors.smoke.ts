#!/usr/bin/env npx tsx
/**
 * `scripts/audit-tenant-auth-errors.ts#aggregateLogs` の smoke test。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/audit-tenant-auth-errors.smoke.ts
 */

import assert from "node:assert/strict";
import { aggregateLogs, type RawLog } from "../audit-tenant-auth-errors.ts";

const ts = "2026-05-19T00:00:00.000Z";
const log = (email: string | null, reason: string | null): RawLog => ({
  email,
  reason,
  occurredAt: ts,
});

// --- domain フィルタなし: reason のみ集計、email は空 ---
{
  const s = aggregateLogs(
    [
      log("a@x.com", "not_in_allowlist"),
      log("b@x.com", "not_in_allowlist"),
      log("c@x.com", "email_not_verified"),
    ],
    null,
    10
  );
  assert.equal(s.totalLogs, 3);
  assert.deepEqual(s.reasonCounts, [
    { reason: "not_in_allowlist", count: 2 },
    { reason: "email_not_verified", count: 1 },
  ]);
  assert.deepEqual(s.filteredEmailCounts, []);
  assert.equal(s.filteredEmailTruncated, 0);
  assert.equal(s.filteredEmailUniqueCount, 0);
}

// --- reason null は (missing) として集計 ---
{
  const s = aggregateLogs([log("a@x.com", null)], null, 10);
  assert.deepEqual(s.reasonCounts, [{ reason: "(missing)", count: 1 }]);
}

// --- domain フィルタあり: 該当 email のみ集計、降順 ---
{
  const s = aggregateLogs(
    [
      log("a@fuku.com", "not_in_allowlist"),
      log("b@fuku.com", "not_in_allowlist"),
      log("a@fuku.com", "email_not_verified"),
      log("x@other.com", "not_in_allowlist"),
      log(null, "not_in_allowlist"),
    ],
    "fuku.com",
    10
  );
  assert.equal(s.totalLogs, 5);
  // reason 全件集計
  assert.deepEqual(s.reasonCounts, [
    { reason: "not_in_allowlist", count: 4 },
    { reason: "email_not_verified", count: 1 },
  ]);
  // email は fuku.com のみ、降順
  assert.deepEqual(s.filteredEmailCounts, [
    { email: "a@fuku.com", count: 2 },
    { email: "b@fuku.com", count: 1 },
  ]);
  assert.equal(s.filteredEmailUniqueCount, 2);
  assert.equal(s.filteredEmailTruncated, 0);
}

// --- top-emails で truncate ---
{
  const logs: RawLog[] = [];
  for (let i = 0; i < 5; i++) logs.push(log(`u${i}@fuku.com`, "not_in_allowlist"));
  // u0 は 3 件、u1 は 2 件 にして、件数順を検証する
  logs.push(log("u0@fuku.com", "not_in_allowlist"));
  logs.push(log("u0@fuku.com", "not_in_allowlist"));
  logs.push(log("u1@fuku.com", "not_in_allowlist"));

  const s = aggregateLogs(logs, "fuku.com", 2);
  assert.equal(s.filteredEmailUniqueCount, 5);
  assert.deepEqual(s.filteredEmailCounts, [
    { email: "u0@fuku.com", count: 3 },
    { email: "u1@fuku.com", count: 2 },
  ]);
  assert.equal(s.filteredEmailTruncated, 3);
}

// --- email 大文字/空白は trim+lowercase で同一エントリに集約 ---
{
  const s = aggregateLogs(
    [
      log("A@Fuku.com", "not_in_allowlist"),
      log(" a@fuku.com ", "not_in_allowlist"),
      log("a@fuku.com", "not_in_allowlist"),
    ],
    "fuku.com",
    10
  );
  assert.equal(s.filteredEmailUniqueCount, 1);
  assert.deepEqual(s.filteredEmailCounts, [
    { email: "a@fuku.com", count: 3 },
  ]);
}

// --- 該当 domain なし ---
{
  const s = aggregateLogs(
    [log("x@other.com", "not_in_allowlist")],
    "fuku.com",
    10
  );
  assert.deepEqual(s.filteredEmailCounts, []);
  assert.equal(s.filteredEmailUniqueCount, 0);
  assert.equal(s.filteredEmailTruncated, 0);
}

// --- 空配列 ---
{
  const s = aggregateLogs([], "fuku.com", 10);
  assert.equal(s.totalLogs, 0);
  assert.deepEqual(s.reasonCounts, []);
  assert.deepEqual(s.filteredEmailCounts, []);
  assert.equal(s.filteredEmailUniqueCount, 0);
}

console.log("audit-tenant-auth-errors smoke test: PASS");
