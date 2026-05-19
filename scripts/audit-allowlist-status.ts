#!/usr/bin/env npx tsx
/**
 * allowed_emails / users / auth_error_logs の現状調査スクリプト（read-only）
 *
 * 目的:
 *   特定メールアドレスがログイン不可となっている問題の切り分けに用いる。
 *   tenant 配下の以下を read-only で参照し、原因 reason を機械的に特定する:
 *     - users コレクション: 該当 email の存在 / role / firebaseUid 紐付け
 *     - allowed_emails コレクション: 該当 email の存在 / 大文字小文字・空白の正規化状態
 *     - auth_error_logs コレクション: 該当 email の直近拒否 reason サマリ
 *
 * 安全機構:
 *   - read-only（書き込み一切なし）
 *   - tenant_id と emails は明示入力必須（無指定で全テナント全 email 走査はしない）
 *   - 出力は input で明示指定された email に絞られるため、PII 漏洩リスクは限定的
 *
 * 使用方法:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *     npx tsx scripts/audit-allowlist-status.ts \
 *     --tenant-id=atali82i \
 *     --emails=a@example.com,b@example.com \
 *     --since-hours=72
 *
 * 環境変数:
 *   GOOGLE_APPLICATION_CREDENTIALS  サービスアカウント JSON のパス（WIF 環境では external_account JSON）
 *   GOOGLE_CLOUD_PROJECT            プロジェクト ID
 */

import {
  initializeApp,
  cert,
  applicationDefault,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore, type Firestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { resolve } from "path";

// ============================================================
// 純粋関数（smoke test 対象）
// ============================================================

export interface AuditEmailInput {
  raw: string;
  normalized: string;
}

/**
 * カンマ区切り email 文字列を正規化済み配列に変換する。
 * 空要素は除去。trim + lowercase で allowed_emails と同等の正規化を行う。
 */
export function parseEmails(input: string): AuditEmailInput[] {
  return input
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map((raw) => ({ raw, normalized: raw.toLowerCase() }));
}

export interface UserRecord {
  id: string;
  email: string | null;
  role: string;
  name: string | null;
  firebaseUid: string | null;
}

export interface AllowedEmailRecord {
  id: string;
  email: string;
  note: string | null;
}

export interface AuthErrorLogRecord {
  reason: string;
  occurredAt: string;
  errorMessage: string | null;
}

export interface PerEmailReport {
  inputEmail: string;
  normalizedEmail: string;
  user: UserRecord | null;
  /** 大文字小文字違いでヒットした users もログイン経路と一致しないため別表示 */
  usersWithCaseDiff: UserRecord[];
  allowedEmail: AllowedEmailRecord | null;
  /** 大文字小文字違いでヒットした allowed_emails */
  allowedEmailsWithCaseDiff: AllowedEmailRecord[];
  authErrors: AuthErrorLogRecord[];
  /** 推定原因（複数該当の優先度: not_in_allowlist > その他 reason > 不明） */
  diagnosis: string;
}

/**
 * 単一 email についての診断結果を組み立てる（純粋関数）。
 * Firestore の生データに依存しない形にすることで smoke test を可能にする。
 */
export function buildPerEmailReport(
  input: AuditEmailInput,
  allUsers: UserRecord[],
  allAllowedEmails: AllowedEmailRecord[],
  authErrors: AuthErrorLogRecord[]
): PerEmailReport {
  const normalizedMatchedUsers = allUsers.filter(
    (u) => u.email?.toLowerCase().trim() === input.normalized
  );
  const exactUserMatch =
    normalizedMatchedUsers.find((u) => u.email === input.normalized) ?? null;
  const usersWithCaseDiff = normalizedMatchedUsers.filter(
    (u) => u.email !== input.normalized
  );

  const normalizedMatchedAllowed = allAllowedEmails.filter(
    (a) => a.email.toLowerCase().trim() === input.normalized
  );
  const exactAllowedMatch =
    normalizedMatchedAllowed.find((a) => a.email === input.normalized) ?? null;
  const allowedEmailsWithCaseDiff = normalizedMatchedAllowed.filter(
    (a) => a.email !== input.normalized
  );

  const diagnosis = computeDiagnosis({
    user: exactUserMatch,
    usersWithCaseDiff,
    allowedEmail: exactAllowedMatch,
    allowedEmailsWithCaseDiff,
    authErrors,
  });

  return {
    inputEmail: input.raw,
    normalizedEmail: input.normalized,
    user: exactUserMatch,
    usersWithCaseDiff,
    allowedEmail: exactAllowedMatch,
    allowedEmailsWithCaseDiff,
    authErrors,
    diagnosis,
  };
}

export function computeDiagnosis(state: {
  user: UserRecord | null;
  usersWithCaseDiff: UserRecord[];
  allowedEmail: AllowedEmailRecord | null;
  allowedEmailsWithCaseDiff: AllowedEmailRecord[];
  authErrors: AuthErrorLogRecord[];
}): string {
  const recentReason = state.authErrors[0]?.reason;

  if (recentReason) {
    return `recent_auth_error_reason=${recentReason}`;
  }

  if (!state.user && state.usersWithCaseDiff.length === 0) {
    return "user_not_found_in_users_collection";
  }

  if (!state.allowedEmail) {
    if (state.allowedEmailsWithCaseDiff.length > 0) {
      return "allowed_email_case_or_whitespace_mismatch";
    }
    return "not_in_allowlist_suspected";
  }

  if (state.user && !state.user.firebaseUid) {
    return "no_firebase_uid_yet_user_has_not_logged_in";
  }

  return "no_recent_auth_error_logs_user_may_have_other_issue";
}

// ============================================================
// CLI 引数パース
// ============================================================

const KNOWN_FLAGS = ["--tenant-id=", "--emails=", "--since-hours="];

const isMainEntry = import.meta.url === `file://${process.argv[1]}`;

if (isMainEntry) {
  void runCli();
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter(
    (a) => !KNOWN_FLAGS.some((k) => a.startsWith(k))
  );
  if (unknownArgs.length > 0) {
    console.error(`[FATAL] 未知のフラグ: ${unknownArgs.join(", ")}`);
    console.error(`  既知のフラグ: ${KNOWN_FLAGS.join(" / ")}`);
    process.exit(1);
  }

  const tenantId = args
    .find((a) => a.startsWith("--tenant-id="))
    ?.split("=")[1];
  const emailsArg = args
    .find((a) => a.startsWith("--emails="))
    ?.split("=")
    .slice(1)
    .join("=");
  const sinceHoursRaw = args
    .find((a) => a.startsWith("--since-hours="))
    ?.split("=")[1];

  if (!tenantId) {
    console.error("[FATAL] --tenant-id は必須です");
    process.exit(1);
  }
  if (!emailsArg) {
    console.error("[FATAL] --emails は必須です（カンマ区切り）");
    process.exit(1);
  }

  const emails = parseEmails(emailsArg);
  if (emails.length === 0) {
    console.error("[FATAL] --emails に有効なメールアドレスがありません");
    process.exit(1);
  }
  if (emails.length > 50) {
    console.error("[FATAL] --emails は 50 件以下にしてください");
    process.exit(1);
  }

  const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : 72;
  if (!Number.isFinite(sinceHours) || sinceHours <= 0 || sinceHours > 24 * 30) {
    console.error(
      `[FATAL] --since-hours は 1〜720 の数値を指定してください: 受け取った値="${sinceHoursRaw}"`
    );
    process.exit(1);
  }

  // Firebase 初期化（cleanup-stuck-quiz-attempts.ts と同じ WIF / SA JSON 兼用ロジック）
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    if (credPath) {
      const jsonPath = resolve(process.cwd(), credPath);
      const credJson = JSON.parse(readFileSync(jsonPath, "utf8")) as {
        type?: string;
      };
      if (credJson.type === "service_account") {
        initializeApp({ credential: cert(credJson as ServiceAccount) });
        console.log(`認証: サービスアカウントJSON (${jsonPath})`);
      } else {
        initializeApp({ credential: applicationDefault() });
        console.log(
          `認証: Application Default Credentials (cred file type=${credJson.type ?? "unknown"})`
        );
      }
    } else {
      initializeApp({ credential: applicationDefault() });
      console.log("認証: Application Default Credentials");
    }
  } catch (err) {
    console.error(
      `[FATAL] Firebase 初期化失敗: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  const db = getFirestore();

  console.log("=== allowed_emails / users / auth_error_logs 調査 ===");
  console.log(`tenant: ${tenantId}`);
  console.log(`emails 件数: ${emails.length}`);
  console.log(`auth_error_logs 参照範囲: 直近 ${sinceHours} 時間\n`);

  const tenantRef = db.collection("tenants").doc(tenantId);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) {
    console.error(`[FATAL] tenant not found: ${tenantId}`);
    process.exit(1);
  }
  console.log(`tenant 確認: ${tenantId} (name="${tenantDoc.data()?.name ?? ""}")\n`);

  const allUsers = await fetchUsers(db, tenantId);
  const allAllowedEmails = await fetchAllowedEmails(db, tenantId);

  console.log(`users 件数: ${allUsers.length}`);
  console.log(`allowed_emails 件数: ${allAllowedEmails.length}\n`);

  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
  const since = new Date(sinceMs);

  const reports: PerEmailReport[] = [];
  for (const email of emails) {
    const authErrors = await fetchAuthErrorLogs(
      db,
      tenantId,
      email.normalized,
      since
    );
    reports.push(buildPerEmailReport(email, allUsers, allAllowedEmails, authErrors));
  }

  printReports(reports);
}

// ============================================================
// Firestore 取得（read-only）
// ============================================================

async function fetchUsers(
  db: Firestore,
  tenantId: string
): Promise<UserRecord[]> {
  const snap = await db.collection(`tenants/${tenantId}/users`).get();
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    return {
      id: d.id,
      email: (data.email as string | undefined) ?? null,
      role: (data.role as string | undefined) ?? "unknown",
      name: (data.name as string | undefined) ?? null,
      firebaseUid: (data.firebaseUid as string | undefined) ?? null,
    };
  });
}

async function fetchAllowedEmails(
  db: Firestore,
  tenantId: string
): Promise<AllowedEmailRecord[]> {
  const snap = await db.collection(`tenants/${tenantId}/allowed_emails`).get();
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    return {
      id: d.id,
      email: (data.email as string | undefined) ?? "",
      note: (data.note as string | undefined) ?? null,
    };
  });
}

async function fetchAuthErrorLogs(
  db: Firestore,
  tenantId: string,
  normalizedEmail: string,
  since: Date
): Promise<AuthErrorLogRecord[]> {
  const snap = await db
    .collection(`tenants/${tenantId}/auth_error_logs`)
    .where("email", "==", normalizedEmail)
    .where("occurredAt", ">=", Timestamp.fromDate(since))
    .orderBy("occurredAt", "desc")
    .limit(20)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    const ts = data.occurredAt;
    const occurredAt =
      ts instanceof Timestamp
        ? ts.toDate().toISOString()
        : typeof ts === "string"
          ? ts
          : new Date(0).toISOString();
    return {
      reason: (data.reason as string | undefined) ?? "unknown",
      occurredAt,
      errorMessage: (data.errorMessage as string | undefined) ?? null,
    };
  });
}

// ============================================================
// 出力
// ============================================================

function printReports(reports: PerEmailReport[]): void {
  console.log("=== 診断結果 ===\n");
  for (const r of reports) {
    console.log(`--- ${r.inputEmail} (normalized=${r.normalizedEmail}) ---`);
    console.log(`診断: ${r.diagnosis}`);

    if (r.user) {
      console.log(
        `  users: 存在 id=${r.user.id} role=${r.user.role} firebaseUid=${r.user.firebaseUid ?? "(未紐付け)"} name="${r.user.name ?? ""}"`
      );
    } else {
      console.log(`  users: 該当なし`);
    }
    if (r.usersWithCaseDiff.length > 0) {
      console.log(
        `  users (大文字小文字/空白の違いあり): ${r.usersWithCaseDiff.length} 件`
      );
      for (const u of r.usersWithCaseDiff) {
        console.log(`    id=${u.id} email="${u.email ?? ""}" role=${u.role}`);
      }
    }

    if (r.allowedEmail) {
      console.log(
        `  allowed_emails: 存在 id=${r.allowedEmail.id} note="${r.allowedEmail.note ?? ""}"`
      );
    } else {
      console.log(`  allowed_emails: 該当なし`);
    }
    if (r.allowedEmailsWithCaseDiff.length > 0) {
      console.log(
        `  allowed_emails (大文字小文字/空白の違いあり): ${r.allowedEmailsWithCaseDiff.length} 件`
      );
      for (const a of r.allowedEmailsWithCaseDiff) {
        console.log(`    id=${a.id} email="${a.email}"`);
      }
    }

    console.log(`  auth_error_logs: ${r.authErrors.length} 件`);
    for (const e of r.authErrors.slice(0, 5)) {
      console.log(`    [${e.occurredAt}] reason=${e.reason}`);
    }
    if (r.authErrors.length > 5) {
      console.log(`    ...他 ${r.authErrors.length - 5} 件`);
    }
    console.log();
  }
}
