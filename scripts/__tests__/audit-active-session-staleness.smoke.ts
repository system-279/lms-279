#!/usr/bin/env npx tsx
/**
 * `scripts/audit-active-session-staleness.ts#aggregateStaleSessions` の smoke test。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/audit-active-session-staleness.smoke.ts
 */

import assert from "node:assert/strict";
import {
  aggregateStaleSessions,
  type RawStaleSession,
  type SessionVideoCompletedFlag,
} from "../audit-active-session-staleness.ts";

const ts = "2026-08-19T00:00:00.000Z";
const ses = (
  lessonId: string | null,
  sessionVideoCompleted: SessionVideoCompletedFlag
): RawStaleSession => ({
  lessonId,
  sessionVideoCompleted,
  deadlineAt: ts,
});

// --- 空入力 ---
{
  const s = aggregateStaleSessions([], 10);
  assert.equal(s.totalStale, 0);
  assert.equal(s.videoCompletedCount, 0);
  assert.equal(s.videoIncompleteCount, 0);
  assert.equal(s.videoUnknownCount, 0);
  assert.deepEqual(s.lessonCounts, []);
  assert.equal(s.lessonTruncated, 0);
  assert.equal(s.lessonUniqueCount, 0);
}

// --- true/false/null の 3 状態切り分け ---
{
  const s = aggregateStaleSessions(
    [
      ses("L1", true),
      ses("L2", false),
      ses("L3", null),
      ses("L1", true),
    ],
    10
  );
  assert.equal(s.totalStale, 4);
  assert.equal(s.videoCompletedCount, 2);
  assert.equal(s.videoIncompleteCount, 1);
  assert.equal(s.videoUnknownCount, 1);
}

// --- lessonId 別降順（sessionVideoCompleted=false のみ算入） + lessonId null は (missing-lessonId) ---
{
  const s = aggregateStaleSessions(
    [
      ses("L1", false),
      ses("L1", false),
      ses("L1", false),
      ses("L2", false),
      ses(null, false),
      ses("L1", true), // 算入されない
      ses("L1", null), // 算入されない
    ],
    10
  );
  assert.equal(s.videoIncompleteCount, 5);
  assert.deepEqual(s.lessonCounts, [
    { lessonId: "L1", count: 3 },
    { lessonId: "L2", count: 1 },
    { lessonId: "(missing-lessonId)", count: 1 },
  ]);
  assert.equal(s.lessonUniqueCount, 3);
  assert.equal(s.lessonTruncated, 0);
}

// --- top-lessons で truncate ---
{
  const sessions: RawStaleSession[] = [];
  for (let i = 0; i < 5; i++) sessions.push(ses(`L${i}`, false));
  sessions.push(ses("L0", false));
  sessions.push(ses("L0", false));
  sessions.push(ses("L1", false));

  const s = aggregateStaleSessions(sessions, 2);
  assert.equal(s.videoIncompleteCount, 8);
  assert.equal(s.lessonUniqueCount, 5);
  assert.deepEqual(s.lessonCounts, [
    { lessonId: "L0", count: 3 },
    { lessonId: "L1", count: 2 },
  ]);
  assert.equal(s.lessonTruncated, 3);
}

// --- 算術不変量: 3 バケット合計が totalStale と一致 / lessonCounts.length + truncated == uniqueCount ---
{
  const sessions: RawStaleSession[] = [
    ses("L1", true),
    ses("L1", false),
    ses("L1", null),
    ses("L2", false),
    ses("L3", false),
    ses(null, false),
  ];
  const s = aggregateStaleSessions(sessions, 1); // top-1 で truncate を起こす

  assert.equal(
    s.videoCompletedCount + s.videoIncompleteCount + s.videoUnknownCount,
    s.totalStale,
    "3 buckets sum != totalStale"
  );
  assert.equal(
    s.lessonCounts.length + s.lessonTruncated,
    s.lessonUniqueCount,
    "lessonCounts.length + truncated != uniqueCount"
  );
}

console.log("✓ audit-active-session-staleness.smoke.ts: all assertions passed");
