#!/usr/bin/env npx tsx
/**
 * `scripts/smoke-dwd-gmail-send.ts` の純粋関数 smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため、node:assert で最低限の回帰検知。
 *   - 特に ADR-037 案 X 採用に伴う --subject-email / --sender 分離パースの回帰防止。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/smoke-dwd-gmail-send.smoke.ts
 */

import assert from "node:assert/strict";

import { CliParseError, parseArgs } from "../smoke-dwd-gmail-send.ts";

// argv 先頭 2 つは Node の node + script path を模擬 (parseArgs は argv.slice(2) を読む)
const argv = (args: string[]): string[] => ["node", "smoke-dwd-gmail-send.ts", ...args];

// --- 既定値: --to のみ指定 (env が無い状態を想定) ---
{
  // env が設定されていると既定値が変わるので、純粋なパース挙動だけ確認するために
  // env-driven 既定値は別 case で検証する
  const opts = parseArgs(argv(["--to=engineer@example.com"]));
  assert.equal(opts.to, "engineer@example.com");
  assert.equal(opts.send, false, "send default is false (dry-run)");
  assert.match(opts.subjectEmail, /@/, "subjectEmail has a default");
  assert.match(opts.sender, /@/, "sender has a default");
  assert.ok(opts.subject.length > 0, "subject has a default");
}

// --- --subject-email と --subject の前方一致 race condition (回帰防止) ---
{
  // "--subject-email=" は "--subject=" より先に判定されること
  const opts = parseArgs(
    argv([
      "--to=a@b.com",
      "--subject-email=alpha@example.com",
      "--subject=[smoke] custom",
    ]),
  );
  assert.equal(opts.subjectEmail, "alpha@example.com");
  assert.equal(opts.subject, "[smoke] custom");
}

// --- 引数順序を逆にしても同じ結果になる ---
{
  const opts = parseArgs(
    argv([
      "--subject=[smoke] custom",
      "--subject-email=alpha@example.com",
      "--to=a@b.com",
    ]),
  );
  assert.equal(opts.subjectEmail, "alpha@example.com");
  assert.equal(opts.subject, "[smoke] custom");
  assert.equal(opts.to, "a@b.com");
}

// --- --sender 上書き ---
{
  const opts = parseArgs(
    argv(["--to=a@b.com", "--sender=display@example.com"]),
  );
  assert.equal(opts.sender, "display@example.com");
}

// --- --send / --dry-run トグル (後勝ち) ---
{
  const sent = parseArgs(argv(["--to=a@b.com", "--send"]));
  assert.equal(sent.send, true);

  const dry = parseArgs(argv(["--to=a@b.com", "--dry-run"]));
  assert.equal(dry.send, false);

  // 後勝ち
  const lastWins = parseArgs(argv(["--to=a@b.com", "--send", "--dry-run"]));
  assert.equal(lastWins.send, false);
}

// --- --to 必須 ---
{
  assert.throws(
    () => parseArgs(argv([])),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /--to=<email> is required/);
      return true;
    },
  );
}

// --- 不正な email 形式: --to ---
{
  assert.throws(
    () => parseArgs(argv(["--to=not-an-email"])),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /--to does not look like a valid email/);
      return true;
    },
  );
}

// --- 不正な email 形式: --subject-email ---
{
  assert.throws(
    () => parseArgs(argv(["--to=a@b.com", "--subject-email=invalid"])),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /--subject-email does not look like a valid email/);
      return true;
    },
  );
}

// --- 不正な email 形式: --sender ---
{
  assert.throws(
    () => parseArgs(argv(["--to=a@b.com", "--sender=invalid"])),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /--sender does not look like a valid email/);
      return true;
    },
  );
}

// --- 未知の引数 ---
{
  assert.throws(
    () => parseArgs(argv(["--to=a@b.com", "--unknown-flag"])),
    (err: unknown) => {
      assert.ok(err instanceof CliParseError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /Unknown argument/);
      return true;
    },
  );
}

// --- --help / -h は exitCode 0 ---
{
  for (const flag of ["--help", "-h"]) {
    assert.throws(
      () => parseArgs(argv([flag])),
      (err: unknown) => {
        assert.ok(err instanceof CliParseError);
        assert.equal(err.exitCode, 0, `${flag} should yield exitCode 0`);
        assert.match(err.message, /Usage:/);
        return true;
      },
    );
  }
}

// --- 前後空白の trim ---
{
  const opts = parseArgs(argv(["--to=  trim@example.com  "]));
  assert.equal(opts.to, "trim@example.com");
}

console.log("smoke-dwd-gmail-send.smoke.ts: all assertions passed");
