#!/usr/bin/env npx tsx
/**
 * `scripts/dispatch-settings-write-cli.ts` の parseArgs / parseScheduleDaysOfWeek
 * smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため、node:assert で最低限の回帰検知。
 *   - Firestore write は副作用が大きいため統合テストは入れない (実機検証は
 *     workflow_dispatch + outcome JSON で行う)。
 *   - 純粋関数 (parseArgs / parseScheduleDaysOfWeek) のみテスト対象。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/dispatch-settings-write-cli.smoke.ts
 */

import assert from "node:assert/strict";

import {
  CliParseError,
  parseArgs,
  parseScheduleDaysOfWeek,
  type CliOptions,
  type WriteResult,
} from "../dispatch-settings-write-cli.ts";

// argv 先頭 2 つは Node 実行模擬 (parseArgs は argv.slice(2) を読む)
const argv = (args: string[]): string[] => [
  "node",
  "dispatch-settings-write-cli.ts",
  ...args,
];

// ============================================================
// parseScheduleDaysOfWeek
// ============================================================

// --- 正常系: 単一の曜日 ---
{
  assert.deepEqual(parseScheduleDaysOfWeek("1"), [1]);
  assert.deepEqual(parseScheduleDaysOfWeek("0"), [0]);
  assert.deepEqual(parseScheduleDaysOfWeek("6"), [6]);
}

// --- 正常系: 複数曜日 + sort + dedupe ---
{
  assert.deepEqual(parseScheduleDaysOfWeek("1,3,5"), [1, 3, 5]);
  // 順序入れ替えても sorted result
  assert.deepEqual(parseScheduleDaysOfWeek("5,1,3"), [1, 3, 5]);
  // 重複は dedupe
  assert.deepEqual(parseScheduleDaysOfWeek("1,1,3"), [1, 3]);
  // 空白許容
  assert.deepEqual(parseScheduleDaysOfWeek(" 1 , 3 "), [1, 3]);
}

// --- 異常系: 空文字 ---
{
  assert.throws(
    () => parseScheduleDaysOfWeek(""),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /at least one day/);
      return true;
    },
  );
  assert.throws(
    () => parseScheduleDaysOfWeek(" , , "),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.equal(err.exitCode, 2);
      return true;
    },
  );
}

// --- 異常系: 範囲外 ---
{
  assert.throws(
    () => parseScheduleDaysOfWeek("7"),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.match(err.message, /\[0, 6\]/);
      return true;
    },
  );
  assert.throws(
    () => parseScheduleDaysOfWeek("-1"),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      return true;
    },
  );
}

// --- 異常系: 非数値 ---
{
  assert.throws(
    () => parseScheduleDaysOfWeek("monday"),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      return true;
    },
  );
}

// --- 仕様確認: parseInt 標準動作の境界 ---
// "1.5" は parseInt が 1 を返す (小数点以下切り捨て)。範囲 [0, 6] 内のため
// validation を通過する。CLI 入力としては意図的でない typo の可能性があるが、
// 標準動作を採用する (厳格な小数拒否は本 smoke では対象外)。
{
  assert.deepEqual(parseScheduleDaysOfWeek("1.5"), [1]);
}

// ============================================================
// parseArgs - 正常系
// ============================================================

{
  const opts = parseArgs(
    argv([
      "--schedule-days-of-week=1",
      "--schedule-hour-jst=9",
      "--signature-name=DXcollege運営スタッフ",
      "--completion-message-body=受講お疲れ様でした。",
    ]),
  );
  assert.deepEqual(opts.scheduleDaysOfWeek, [1]);
  assert.equal(opts.scheduleHourJst, 9);
  assert.equal(opts.signatureName, "DXcollege運営スタッフ");
  assert.equal(opts.completionMessageBody, "受講お疲れ様でした。");
  assert.match(opts.updatedBy, /@/, "updatedBy has default value with email shape");
}

// --- updated-by 明示指定 ---
{
  const opts = parseArgs(
    argv([
      "--schedule-days-of-week=1",
      "--schedule-hour-jst=9",
      "--signature-name=sig",
      "--completion-message-body=body",
      "--updated-by=admin@example.com",
    ]),
  );
  assert.equal(opts.updatedBy, "admin@example.com");
}

// ============================================================
// parseArgs - 必須引数欠落
// ============================================================

const REQUIRED_FLAGS = [
  {
    omit: "--schedule-days-of-week=",
    label: "schedule-days-of-week",
  },
  {
    omit: "--schedule-hour-jst=",
    label: "schedule-hour-jst",
  },
  {
    omit: "--signature-name=",
    label: "signature-name",
  },
  {
    omit: "--completion-message-body=",
    label: "completion-message-body",
  },
];

for (const { omit, label } of REQUIRED_FLAGS) {
  const allArgs = [
    "--schedule-days-of-week=1",
    "--schedule-hour-jst=9",
    "--signature-name=sig",
    "--completion-message-body=body",
  ];
  const reduced = allArgs.filter((a) => !a.startsWith(omit));
  assert.throws(
    () => parseArgs(argv(reduced)),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError, `missing ${label} should throw`);
      assert.equal(err.exitCode, 2);
      return true;
    },
    `missing ${label} flag did not throw`,
  );
}

// ============================================================
// parseArgs - 範囲外
// ============================================================

{
  // schedule-hour-jst out of range
  assert.throws(
    () =>
      parseArgs(
        argv([
          "--schedule-days-of-week=1",
          "--schedule-hour-jst=24",
          "--signature-name=sig",
          "--completion-message-body=body",
        ]),
      ),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.match(err.message, /schedule-hour-jst/);
      return true;
    },
  );
}

// --- signature 空 ---
{
  assert.throws(
    () =>
      parseArgs(
        argv([
          "--schedule-days-of-week=1",
          "--schedule-hour-jst=9",
          "--signature-name=",
          "--completion-message-body=body",
        ]),
      ),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.match(err.message, /signature-name length/);
      return true;
    },
  );
}

// --- signature 101 chars (上限超過) ---
{
  const oversize = "a".repeat(101);
  assert.throws(
    () =>
      parseArgs(
        argv([
          "--schedule-days-of-week=1",
          "--schedule-hour-jst=9",
          `--signature-name=${oversize}`,
          "--completion-message-body=body",
        ]),
      ),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      return true;
    },
  );
}

// --- body 空 ---
{
  assert.throws(
    () =>
      parseArgs(
        argv([
          "--schedule-days-of-week=1",
          "--schedule-hour-jst=9",
          "--signature-name=sig",
          "--completion-message-body=",
        ]),
      ),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.match(err.message, /completion-message-body length/);
      return true;
    },
  );
}

// --- 未知の flag ---
{
  assert.throws(
    () =>
      parseArgs(
        argv([
          "--schedule-days-of-week=1",
          "--schedule-hour-jst=9",
          "--signature-name=sig",
          "--completion-message-body=body",
          "--unknown",
        ]),
      ),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.match(err.message, /Unknown argument/);
      return true;
    },
  );
}

// --- --help は exitCode 0 ---
{
  for (const flag of ["--help", "-h"]) {
    assert.throws(
      () => parseArgs(argv([flag])),
      (err: unknown) => {
        assert.ok(err instanceof CliParseError);
        assert.equal(err.exitCode, 0);
        assert.match(err.message, /Usage:/);
        return true;
      },
    );
  }
}

// ============================================================
// 型 sanity
// ============================================================

{
  const opts: CliOptions = {
    scheduleDaysOfWeek: [1, 3],
    scheduleHourJst: 9,
    signatureName: "sig",
    completionMessageBody: "body",
    updatedBy: "test@example.com",
  };
  assert.ok(Array.isArray(opts.scheduleDaysOfWeek));

  const result: WriteResult = {
    evaluatedAt: "2026-05-24T00:00:00.000Z",
    outcome: "created",
    previousVersion: null,
    newVersion: 1,
    settings: {
      enabled: false,
      scheduleDaysOfWeek: [1],
      scheduleHourJst: 9,
      signatureName: "sig",
      completionMessageBodyLength: 10,
      senderEmail: "dxcollege@279279.net",
      version: 1,
    },
  };
  assert.equal(result.outcome, "created");
  assert.equal(result.settings?.enabled, false, "テスト段階の write は enabled=false 必須");
}

console.log("dispatch-settings-write-cli.smoke.ts: all assertions passed");
