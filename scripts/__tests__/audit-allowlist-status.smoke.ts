#!/usr/bin/env npx tsx
/**
 * `scripts/audit-allowlist-status.ts` の純粋関数 smoke test。
 *
 * 位置づけ:
 *   - scripts/ 配下は vitest workspace 対象外のため、node:assert で最低限の回帰検知。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/audit-allowlist-status.smoke.ts
 */

import assert from "node:assert/strict";
import {
  parseEmails,
  buildPerEmailReport,
  computeDiagnosis,
  type AllowedEmailRecord,
  type AuthErrorLogRecord,
  type UserRecord,
} from "../audit-allowlist-status.ts";

// --- parseEmails ---
{
  assert.deepEqual(parseEmails("a@x.com,B@Y.com"), [
    { raw: "a@x.com", normalized: "a@x.com" },
    { raw: "B@Y.com", normalized: "b@y.com" },
  ]);
  assert.deepEqual(parseEmails(" a@x.com , , b@x.com "), [
    { raw: "a@x.com", normalized: "a@x.com" },
    { raw: "b@x.com", normalized: "b@x.com" },
  ]);
  assert.deepEqual(parseEmails(""), []);
}

const baseUser = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  id: "u1",
  email: "a@x.com",
  role: "student",
  name: null,
  firebaseUid: null,
  ...overrides,
});

const baseAllowed = (
  overrides: Partial<AllowedEmailRecord> = {}
): AllowedEmailRecord => ({
  id: "ae1",
  email: "a@x.com",
  note: null,
  ...overrides,
});

const errLog = (
  reason: string,
  occurredAt = "2026-05-19T00:00:00.000Z"
): AuthErrorLogRecord => ({
  reason,
  occurredAt,
  errorMessage: null,
});

// --- computeDiagnosis ---
{
  // 直近 auth_error_logs があれば最優先で reason を返す
  assert.equal(
    computeDiagnosis({
      user: baseUser(),
      usersWithCaseDiff: [],
      allowedEmail: baseAllowed(),
      allowedEmailsWithCaseDiff: [],
      authErrors: [errLog("not_in_allowlist"), errLog("email_not_verified")],
    }),
    "recent_auth_error_reason=not_in_allowlist"
  );

  // user 不在
  assert.equal(
    computeDiagnosis({
      user: null,
      usersWithCaseDiff: [],
      allowedEmail: null,
      allowedEmailsWithCaseDiff: [],
      authErrors: [],
    }),
    "user_not_found_in_users_collection"
  );

  // allowed_emails 完全一致なし + ケース違いあり
  assert.equal(
    computeDiagnosis({
      user: baseUser(),
      usersWithCaseDiff: [],
      allowedEmail: null,
      allowedEmailsWithCaseDiff: [baseAllowed({ email: "A@X.com" })],
      authErrors: [],
    }),
    "allowed_email_case_or_whitespace_mismatch"
  );

  // allowed_emails 完全に未登録（ケース違いもなし）
  assert.equal(
    computeDiagnosis({
      user: baseUser(),
      usersWithCaseDiff: [],
      allowedEmail: null,
      allowedEmailsWithCaseDiff: [],
      authErrors: [],
    }),
    "not_in_allowlist_suspected"
  );

  // user 存在 + allowed_emails 存在 + firebaseUid 未紐付け
  assert.equal(
    computeDiagnosis({
      user: baseUser({ firebaseUid: null }),
      usersWithCaseDiff: [],
      allowedEmail: baseAllowed(),
      allowedEmailsWithCaseDiff: [],
      authErrors: [],
    }),
    "no_firebase_uid_yet_user_has_not_logged_in"
  );

  // 全て整っているが auth_error_logs が直近にない（別原因の可能性）
  assert.equal(
    computeDiagnosis({
      user: baseUser({ firebaseUid: "uid-1" }),
      usersWithCaseDiff: [],
      allowedEmail: baseAllowed(),
      allowedEmailsWithCaseDiff: [],
      authErrors: [],
    }),
    "no_recent_auth_error_logs_user_may_have_other_issue"
  );
}

// --- buildPerEmailReport ---
{
  const input = { raw: "A@X.com", normalized: "a@x.com" };

  // user/allowed_emails ともに完全一致
  const r1 = buildPerEmailReport(
    input,
    [baseUser({ email: "a@x.com", firebaseUid: "uid-1" })],
    [baseAllowed({ email: "a@x.com" })],
    []
  );
  assert.equal(r1.user?.email, "a@x.com");
  assert.equal(r1.allowedEmail?.email, "a@x.com");
  assert.equal(r1.usersWithCaseDiff.length, 0);
  assert.equal(r1.allowedEmailsWithCaseDiff.length, 0);

  // allowed_emails が大文字混入のみ存在 → ケース違いに分類
  const r2 = buildPerEmailReport(
    input,
    [baseUser({ email: "a@x.com", firebaseUid: "uid-1" })],
    [baseAllowed({ email: "A@x.com" })],
    []
  );
  assert.equal(r2.allowedEmail, null);
  assert.equal(r2.allowedEmailsWithCaseDiff.length, 1);
  assert.equal(r2.diagnosis, "allowed_email_case_or_whitespace_mismatch");

  // users 側も大文字混入のみ
  const r3 = buildPerEmailReport(
    input,
    [baseUser({ email: " A@X.com " })],
    [],
    []
  );
  assert.equal(r3.user, null);
  assert.equal(r3.usersWithCaseDiff.length, 1);

  // 直近の auth_error_logs があれば最優先
  const r4 = buildPerEmailReport(
    input,
    [baseUser({ email: "a@x.com", firebaseUid: "uid-1" })],
    [baseAllowed({ email: "a@x.com" })],
    [errLog("not_in_allowlist")]
  );
  assert.equal(r4.diagnosis, "recent_auth_error_reason=not_in_allowlist");
}

console.log("audit-allowlist-status smoke test: PASS");
