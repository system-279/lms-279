#!/usr/bin/env npx tsx
/**
 * `scripts/audit-session-force-exits.ts#aggregateSessions` の smoke test。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/audit-session-force-exits.smoke.ts
 */

import assert from "node:assert/strict";
import { aggregateSessions, type RawSession } from "../audit-session-force-exits.ts";

const ts = "2026-05-19T00:00:00.000Z";
const ses = (
  lessonId: string | null,
  exitReason: string | null,
  sessionVideoCompleted: boolean
): RawSession => ({
  lessonId,
  exitReason,
  sessionVideoCompleted,
  exitAt: ts,
});

// --- 空入力 ---
{
  const s = aggregateSessions([], 10);
  assert.equal(s.totalForceExits, 0);
  assert.deepEqual(s.reasonCounts, []);
  assert.equal(s.timeLimitVideoIncomplete, 0);
  assert.equal(s.timeLimitVideoCompleted, 0);
  assert.deepEqual(s.caseELessonCounts, []);
  assert.equal(s.caseELessonTruncated, 0);
  assert.equal(s.caseELessonUniqueCount, 0);
}

// --- reason 別件数（降順） + null は (missing) ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", false),
      ses("L1", "time_limit", false),
      ses("L2", "pause_timeout", false),
      ses("L3", null, false),
    ],
    10
  );
  assert.equal(s.totalForceExits, 4);
  assert.deepEqual(s.reasonCounts, [
    { reason: "time_limit", count: 2 },
    { reason: "pause_timeout", count: 1 },
    { reason: "(missing)", count: 1 },
  ]);
}

// --- time_limit 内訳（ケース E / B 切り分け） ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", false), // ケース E
      ses("L1", "time_limit", false), // ケース E
      ses("L2", "time_limit", true),  // ケース B
      ses("L3", "pause_timeout", false), // 内訳対象外
      ses("L4", "time_limit", true),  // ケース B
    ],
    10
  );
  assert.equal(s.timeLimitVideoIncomplete, 2);
  assert.equal(s.timeLimitVideoCompleted, 2);
}

// --- ケース E lesson 別降順 + lessonId null は (missing-lessonId) ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", false),
      ses("L1", "time_limit", false),
      ses("L1", "time_limit", false),
      ses("L2", "time_limit", false),
      ses(null, "time_limit", false),
      // ケース B / 他 reason は caseE に含まれない
      ses("L1", "time_limit", true),
      ses("L1", "pause_timeout", false),
    ],
    10
  );
  assert.equal(s.timeLimitVideoIncomplete, 5);
  assert.deepEqual(s.caseELessonCounts, [
    { lessonId: "L1", count: 3 },
    { lessonId: "L2", count: 1 },
    { lessonId: "(missing-lessonId)", count: 1 },
  ]);
  assert.equal(s.caseELessonUniqueCount, 3);
  assert.equal(s.caseELessonTruncated, 0);
}

// --- top-lessons で truncate ---
{
  const sessions: RawSession[] = [];
  // L0..L4 を各 1 件 + L0 をさらに 2 件、L1 をさらに 1 件
  for (let i = 0; i < 5; i++) sessions.push(ses(`L${i}`, "time_limit", false));
  sessions.push(ses("L0", "time_limit", false));
  sessions.push(ses("L0", "time_limit", false));
  sessions.push(ses("L1", "time_limit", false));

  const s = aggregateSessions(sessions, 2);
  assert.equal(s.timeLimitVideoIncomplete, 8);
  assert.equal(s.caseELessonUniqueCount, 5);
  assert.deepEqual(s.caseELessonCounts, [
    { lessonId: "L0", count: 3 },
    { lessonId: "L1", count: 2 },
  ]);
  assert.equal(s.caseELessonTruncated, 3);
}

// --- ケース E がゼロでもケース B / 他 reason は集計される ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", true),
      ses("L2", "pause_timeout", true),
      ses("L3", "max_attempts_failed", false),
    ],
    10
  );
  assert.equal(s.totalForceExits, 3);
  assert.equal(s.timeLimitVideoIncomplete, 0);
  assert.equal(s.timeLimitVideoCompleted, 1);
  assert.deepEqual(s.caseELessonCounts, []);
  assert.equal(s.caseELessonUniqueCount, 0);
  assert.deepEqual(s.reasonCounts, [
    { reason: "time_limit", count: 1 },
    { reason: "pause_timeout", count: 1 },
    { reason: "max_attempts_failed", count: 1 },
  ]);
}

console.log("✓ audit-session-force-exits.smoke.ts: all assertions passed");
