#!/usr/bin/env npx tsx
/**
 * `scripts/cleanup-stuck-quiz-attempts.ts#isStuckAttempt` の smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため、node:assert で最低限の回帰検知。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/cleanup-stuck-quiz-attempts.smoke.ts
 */

import assert from "node:assert/strict";
import {
  isStuckAttempt,
  type AttemptInfo,
  type SessionInfo,
} from "../cleanup-stuck-quiz-attempts.ts";

const nowMs = Date.parse("2026-05-19T03:00:00Z");
const future = new Date(nowMs + 60 * 60 * 1000).toISOString();
const past = new Date(nowMs - 60 * 60 * 1000).toISOString();

const baseAttempt: AttemptInfo = {
  id: "a1",
  status: "in_progress",
  startedAt: past,
  quizId: "q1",
  userId: "u1",
};

type Case = {
  name: string;
  attempt: AttemptInfo;
  sessions: SessionInfo[];
  expected: boolean;
};

const cases: Case[] = [
  {
    name: "status != in_progress は対象外 (submitted)",
    attempt: { ...baseAttempt, status: "submitted" },
    sessions: [],
    expected: false,
  },
  {
    name: "status != in_progress は対象外 (timed_out)",
    attempt: { ...baseAttempt, status: "timed_out" },
    sessions: [{ id: "s1", status: "force_exited", deadlineAt: past }],
    expected: false,
  },
  {
    name: "関連 session 不在 → 対象（孤児 attempt）",
    attempt: baseAttempt,
    sessions: [],
    expected: true,
  },
  {
    name: "全 session が force_exited → 対象",
    attempt: baseAttempt,
    sessions: [
      { id: "s1", status: "force_exited", deadlineAt: past },
      { id: "s2", status: "force_exited", deadlineAt: past },
    ],
    expected: true,
  },
  {
    name: "全 session が abandoned → 対象",
    attempt: baseAttempt,
    sessions: [{ id: "s1", status: "abandoned", deadlineAt: past }],
    expected: true,
  },
  {
    name: "全 session が completed → 対象（active 不在）",
    attempt: baseAttempt,
    sessions: [{ id: "s1", status: "completed", deadlineAt: past }],
    expected: true,
  },
  {
    name: "active session が deadline 内（未来）→ 対象外（まだ使用中）",
    attempt: baseAttempt,
    sessions: [{ id: "s1", status: "active", deadlineAt: future }],
    expected: false,
  },
  {
    name: "active session が deadline 超過 → 対象（期限切れ active）",
    attempt: baseAttempt,
    sessions: [{ id: "s1", status: "active", deadlineAt: past }],
    expected: true,
  },
  {
    name: "active と force_exited が混在、active が deadline 内 → 対象外",
    attempt: baseAttempt,
    sessions: [
      { id: "s1", status: "force_exited", deadlineAt: past },
      { id: "s2", status: "active", deadlineAt: future },
    ],
    expected: false,
  },
  {
    name: "active と force_exited が混在、active が deadline 超過 → 対象",
    attempt: baseAttempt,
    sessions: [
      { id: "s1", status: "force_exited", deadlineAt: past },
      { id: "s2", status: "active", deadlineAt: past },
    ],
    expected: true,
  },
];

let pass = 0;
let fail = 0;
for (const tc of cases) {
  try {
    const actual = isStuckAttempt(tc.attempt, tc.sessions, nowMs);
    assert.equal(actual, tc.expected, `${tc.name}: expected=${tc.expected} actual=${actual}`);
    console.log(`  PASS: ${tc.name}`);
    pass++;
  } catch (err) {
    console.error(`  FAIL: ${tc.name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    fail++;
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
