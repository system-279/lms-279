#!/usr/bin/env npx tsx
/**
 * `scripts/normalize-users-email.ts#planNormalization` の smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため、node:assert で最低限の回帰検知を行う。
 *   - 本格的なユニットテストは `planNormalization` を services/api 配下へ移設した後に追加する（Issue で追跡）。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/normalize-users-email.smoke.ts
 */

import assert from "node:assert/strict";
import {
  planNormalization,
  type UserEmailDoc,
} from "../normalize-users-email.ts";

type Case = {
  name: string;
  input: UserEmailDoc[];
  expected: { updates: number; skips: number };
  extraAssertions?: (plan: ReturnType<typeof planNormalization>) => void;
};

const cases: Case[] = [
  {
    name: "正規化済みのみは updates/skips ともに空",
    input: [{ id: "u1", email: "alice@x.com" }],
    expected: { updates: 0, skips: 0 },
  },
  {
    name: "大文字混入 1 件は updates 1 件",
    input: [{ id: "u1", email: "Alice@X.com" }],
    expected: { updates: 1, skips: 0 },
    extraAssertions: (plan) => {
      assert.equal(plan.updates[0].before, "Alice@X.com");
      assert.equal(plan.updates[0].after, "alice@x.com");
    },
  },
  {
    name: "前後空白のみは updates 1 件",
    input: [{ id: "u1", email: "  alice@x.com  " }],
    expected: { updates: 1, skips: 0 },
    extraAssertions: (plan) => {
      assert.equal(plan.updates[0].after, "alice@x.com");
    },
  },
  {
    name: "既存正規化済みと衝突するケースは skips 1 件 / updates 0 件",
    input: [
      { id: "u1", email: "alice@x.com" },
      { id: "u2", email: "Alice@x.com" },
    ],
    expected: { updates: 0, skips: 1 },
    extraAssertions: (plan) => {
      assert.equal(plan.skips[0].id, "u2");
      assert.equal(plan.skips[0].before, "Alice@x.com");
      assert.equal(plan.skips[0].after, "alice@x.com");
    },
  },
  {
    name: "未正規化 2 件が同じ正規化結果: 先頭が updates、後続が skips（順序依存）",
    input: [
      { id: "u1", email: "Alice@x.com" },
      { id: "u2", email: "  alice@X.com " },
    ],
    expected: { updates: 1, skips: 1 },
    extraAssertions: (plan) => {
      assert.equal(plan.updates[0].id, "u1");
      assert.equal(plan.skips[0].id, "u2");
    },
  },
  {
    name: "空 email / undefined は無視",
    input: [
      { id: "u1", email: "" },
      { id: "u2", email: undefined },
    ],
    expected: { updates: 0, skips: 0 },
  },
  {
    name: "null が UserEmailDoc.email に入っても crash せず無視（Firestore null 防御）",
    // main() 側で `typeof raw === "string"` を通るため null は届かないが、
    // planNormalization 単体に null が渡るリグレッションに備えた defensive test。
    input: [{ id: "u1", email: null as unknown as undefined }],
    expected: { updates: 0, skips: 0 },
  },
  {
    name: "空配列は updates/skips ともに空",
    input: [],
    expected: { updates: 0, skips: 0 },
  },
  {
    name: "正規化済みと未正規化が混在するテナント（複雑ケース）",
    input: [
      { id: "u1", email: "alice@x.com" }, // 正規化済み、normalizedSet に初期登録
      { id: "u2", email: "Bob@x.com" }, // 未正規化、衝突なし -> updates
      { id: "u3", email: "ALICE@x.com" }, // 未正規化、u1 と衝突 -> skips
      { id: "u4", email: "  bob@x.com  " }, // 未正規化、u2 の正規化結果と衝突 -> skips
    ],
    expected: { updates: 1, skips: 2 },
    extraAssertions: (plan) => {
      assert.equal(plan.updates[0].id, "u2");
      const skipIds = plan.skips.map((s) => s.id).sort();
      assert.deepEqual(skipIds, ["u3", "u4"]);
    },
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  try {
    const plan = planNormalization(c.input);
    assert.equal(plan.updates.length, c.expected.updates, `updates length for "${c.name}"`);
    assert.equal(plan.skips.length, c.expected.skips, `skips length for "${c.name}"`);
    c.extraAssertions?.(plan);
    console.log(
      `PASS: ${c.name} -> { updates: ${plan.updates.length}, skips: ${plan.skips.length} }`
    );
    pass++;
  } catch (err) {
    console.error(`FAIL: ${c.name}`);
    console.error(err);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
