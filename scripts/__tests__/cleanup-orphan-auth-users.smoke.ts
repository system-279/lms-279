#!/usr/bin/env npx tsx
/**
 * `scripts/cleanup-orphan-auth-users.ts#classifyUser` の smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため、node:assert で最低限の回帰検知。
 *   - classifyUser は runCleanup の listUsers ループから抽出した純粋関数。
 *     判定順序（email → disabled → creationTime NaN → min-age → 登録有無）と
 *     境界値（min-age ±1 / 経過時間ちょうど）・異常系（null/空 email / NaN）を検証する。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/cleanup-orphan-auth-users.smoke.ts
 */

import assert from "node:assert/strict";
import {
  classifyUser,
  type ClassifyUserInput,
  type ClassifyOptions,
  type UserClassification,
} from "../cleanup-orphan-auth-users.ts";

const nowMs = Date.parse("2026-05-22T00:00:00Z");
const MIN_AGE_SEC = 3600; // 1 時間

const registeredEmails = new Set<string>(["registered@example.com"]);

// 経過時間（秒）から creationTime ISO 文字列を作る
const createdAtAgeSec = (ageSec: number): string =>
  new Date(nowMs - ageSec * 1000).toISOString();

const baseOpts: ClassifyOptions = {
  minAgeSec: MIN_AGE_SEC,
  includeDisabled: false,
  nowMs,
};

// age が十分経過した（min-age 超え）正常作成時刻
const oldEnough = createdAtAgeSec(MIN_AGE_SEC + 100);

type Case = {
  name: string;
  user: ClassifyUserInput;
  opts?: Partial<ClassifyOptions>;
  expected: UserClassification;
};

const cases: Case[] = [
  // --- 異常系: email ---
  {
    name: "email undefined → skip-no-email",
    user: { email: undefined, disabled: false, creationTime: oldEnough },
    expected: "skip-no-email",
  },
  {
    name: "email 空文字 → skip-no-email",
    user: { email: "", disabled: false, creationTime: oldEnough },
    expected: "skip-no-email",
  },
  {
    name: "email 空白のみ（trim で空）→ skip-no-email",
    user: { email: "   ", disabled: false, creationTime: oldEnough },
    expected: "skip-no-email",
  },
  // --- 判定順序: email チェックが disabled より優先 ---
  {
    name: "email 空 かつ disabled=true → skip-no-email（email が優先）",
    user: { email: "", disabled: true, creationTime: oldEnough },
    expected: "skip-no-email",
  },

  // --- disabled ---
  {
    name: "disabled=true, includeDisabled=false → skip-disabled",
    user: { email: "orphan@example.com", disabled: true, creationTime: oldEnough },
    expected: "skip-disabled",
  },
  {
    name: "disabled=true, includeDisabled=true, 未登録 → orphan",
    user: { email: "orphan@example.com", disabled: true, creationTime: oldEnough },
    opts: { includeDisabled: true },
    expected: "orphan",
  },

  // --- 異常系: creationTime ---
  {
    name: "creationTime が parse 不能 → skip-invalid-creation-time",
    user: { email: "orphan@example.com", disabled: false, creationTime: "not-a-date" },
    expected: "skip-invalid-creation-time",
  },
  {
    name: "creationTime 空文字 → skip-invalid-creation-time",
    user: { email: "orphan@example.com", disabled: false, creationTime: "" },
    expected: "skip-invalid-creation-time",
  },

  // --- 境界値: min-age ---
  {
    name: "経過 = min-age ちょうど（< 判定なので too-young でない）→ orphan",
    user: {
      email: "orphan@example.com",
      disabled: false,
      creationTime: createdAtAgeSec(MIN_AGE_SEC),
    },
    expected: "orphan",
  },
  {
    name: "経過 = min-age - 1 秒 → skip-too-young",
    user: {
      email: "orphan@example.com",
      disabled: false,
      creationTime: createdAtAgeSec(MIN_AGE_SEC - 1),
    },
    expected: "skip-too-young",
  },
  {
    name: "経過 = min-age + 1 秒 → orphan",
    user: {
      email: "orphan@example.com",
      disabled: false,
      creationTime: createdAtAgeSec(MIN_AGE_SEC + 1),
    },
    expected: "orphan",
  },

  // --- 登録有無 ---
  {
    name: "登録済みメール（age ok）→ registered（保持）",
    user: { email: "registered@example.com", disabled: false, creationTime: oldEnough },
    expected: "registered",
  },
  {
    name: "未登録メール（age ok）→ orphan",
    user: { email: "orphan@example.com", disabled: false, creationTime: oldEnough },
    expected: "orphan",
  },
  {
    name: "登録済みメールを大文字 + 前後空白 → 正規化されて registered",
    user: {
      email: "  Registered@Example.COM ",
      disabled: false,
      creationTime: oldEnough,
    },
    expected: "registered",
  },
];

let pass = 0;
let fail = 0;
for (const tc of cases) {
  try {
    const actual = classifyUser(tc.user, registeredEmails, {
      ...baseOpts,
      ...tc.opts,
    });
    assert.equal(
      actual,
      tc.expected,
      `${tc.name}: expected=${tc.expected} actual=${actual}`
    );
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
