#!/usr/bin/env npx tsx
/**
 * `scripts/audit-session-force-exits.ts#aggregateSessions` の smoke test。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/audit-session-force-exits.smoke.ts
 */

import assert from "node:assert/strict";
import {
  aggregateSessions,
  type RawSession,
  type SessionVideoCompletedFlag,
} from "../audit-session-force-exits.ts";

const ts = "2026-05-19T00:00:00.000Z";
const ses = (
  lessonId: string | null,
  exitReason: string | null,
  sessionVideoCompleted: SessionVideoCompletedFlag
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
  assert.equal(s.timeLimitVideoUnknown, 0);
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

// --- time_limit 内訳（ケース E / B / 不明 の 3 状態切り分け） ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", false), // ケース E
      ses("L1", "time_limit", false), // ケース E
      ses("L2", "time_limit", true),  // ケース B
      ses("L3", "pause_timeout", false), // 内訳対象外
      ses("L4", "time_limit", true),  // ケース B
      ses("L5", "time_limit", null),  // 不明（KPI 保留）
    ],
    10
  );
  assert.equal(s.timeLimitVideoIncomplete, 2);
  assert.equal(s.timeLimitVideoCompleted, 2);
  assert.equal(s.timeLimitVideoUnknown, 1);
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
      // ケース B / 不明 / 他 reason は caseE に含まれない
      ses("L1", "time_limit", true),
      ses("L1", "time_limit", null),
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

// --- top-lessons == unique count: truncated=0 で全件返る ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", false),
      ses("L2", "time_limit", false),
      ses("L3", "time_limit", false),
    ],
    3
  );
  assert.equal(s.caseELessonUniqueCount, 3);
  assert.equal(s.caseELessonCounts.length, 3);
  assert.equal(s.caseELessonTruncated, 0);
}

// --- top-lessons > unique count: truncated は負値クランプで 0 ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", false),
      ses("L2", "time_limit", false),
    ],
    10
  );
  assert.equal(s.caseELessonUniqueCount, 2);
  assert.equal(s.caseELessonCounts.length, 2);
  assert.equal(s.caseELessonTruncated, 0); // Math.max(0, -8)
}

// --- ケース E がゼロでもケース B / 不明 / 他 reason は集計される ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", true),
      ses("L2", "pause_timeout", true),
      ses("L3", "max_attempts_failed", false),
      ses("L4", "time_limit", null),
    ],
    10
  );
  assert.equal(s.totalForceExits, 4);
  assert.equal(s.timeLimitVideoIncomplete, 0);
  assert.equal(s.timeLimitVideoCompleted, 1);
  assert.equal(s.timeLimitVideoUnknown, 1);
  assert.deepEqual(s.caseELessonCounts, []);
  assert.equal(s.caseELessonUniqueCount, 0);
  assert.deepEqual(s.reasonCounts, [
    { reason: "time_limit", count: 2 },
    { reason: "pause_timeout", count: 1 },
    { reason: "max_attempts_failed", count: 1 },
  ]);
}

// --- 同件数の lessonId 複数: stable sort で順序を確定（length と内容を確認） ---
{
  const s = aggregateSessions(
    [
      ses("L1", "time_limit", false),
      ses("L2", "time_limit", false),
      ses("L3", "time_limit", false),
    ],
    10
  );
  assert.equal(s.caseELessonCounts.length, 3);
  // 件数は全部 1、順序は insertion-order（ECMA-2019 stable sort 仕様）
  assert.deepEqual(
    s.caseELessonCounts.map((x) => x.count),
    [1, 1, 1]
  );
  // unique lessonId が全て含まれる（順序非依存）
  const lessons = s.caseELessonCounts.map((x) => x.lessonId).sort();
  assert.deepEqual(lessons, ["L1", "L2", "L3"]);
}

// --- 算術不変量: reasonCounts の合計が totalForceExits と一致 ---
// --- 算術不変量: timeLimit の 3 バケット合計が reasonCounts["time_limit"] と一致 ---
// --- 算術不変量: caseELessonCounts.length + caseELessonTruncated == caseELessonUniqueCount ---
{
  const sessions: RawSession[] = [
    ses("L1", "time_limit", false),
    ses("L1", "time_limit", true),
    ses("L1", "time_limit", null),
    ses("L2", "time_limit", false),
    ses("L3", "pause_timeout", true),
    ses("L4", "max_attempts_failed", false),
    ses(null, null, false),
  ];
  const s = aggregateSessions(sessions, 1); // top-1 で truncate を起こす

  const sumReasons = s.reasonCounts.reduce((n, x) => n + x.count, 0);
  assert.equal(sumReasons, s.totalForceExits, "reasonCounts sum != totalForceExits");

  const timeLimitTotal =
    s.reasonCounts.find((x) => x.reason === "time_limit")?.count ?? 0;
  assert.equal(
    s.timeLimitVideoIncomplete + s.timeLimitVideoCompleted + s.timeLimitVideoUnknown,
    timeLimitTotal,
    "timeLimit 3 buckets sum != reasonCounts[time_limit]"
  );

  assert.equal(
    s.caseELessonCounts.length + s.caseELessonTruncated,
    s.caseELessonUniqueCount,
    "caseELessonCounts.length + truncated != uniqueCount"
  );
}

console.log("✓ audit-session-force-exits.smoke.ts: all assertions passed");
