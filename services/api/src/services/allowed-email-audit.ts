/**
 * allowed_emails 棚卸しロジック（純粋関数）
 *
 * 目的:
 *   Issue #278（既存 users 経路にも allowlist 再チェック）導入前に、
 *   「users レコードは存在するが allowed_emails に登録されていない」ユーザーを
 *   事前検出し、本番デプロイ直後の一斉ブロックを防ぐ。
 *
 * 設計:
 *   - Firestore アクセスから切り離した純粋関数として planAudit を export。
 *   - CLI（scripts/audit-users-vs-allowed-emails.ts）は Firestore IO と
 *     Firebase Auth metadata 取得・出力・書き込みのみを担当する。
 *
 * 分類:
 *   - matched: users と allowed_emails の両方にある
 *   - usersWithoutAllowedEmail: users にあるが allowed_emails にない（Issue #278 で弾かれる）
 *   - allowedEmailsWithoutUser: allowed_emails にあるが users にない（招待済み未ログイン）
 *   - invalid: email が空/null の不正データ
 *
 * スーパー管理者は allowed_emails 外で通過可能な設計のため
 * usersWithoutAllowedEmail から除外する（補正対象外）。
 */

import { normalizeEmail as normalizeEmailUtil } from "../utils/tenant-id.js";

export type AuditUserInput = {
  id: string;
  email: string | null | undefined;
  firebaseUid?: string;
  role: string;
  createdAt: string;
  /** Firebase Auth から取得した最終サインイン時刻。取得不可なら null */
  lastSignInTime?: string | null;
};

export type AuditAllowedEmailInput = {
  id: string;
  email: string | null | undefined;
};

export type MatchedEntry = {
  userId: string;
  firebaseUid?: string;
  email: string;
  allowedEmailId: string;
};

export type UserWithoutAllowedEmailEntry = {
  userId: string;
  firebaseUid?: string;
  email: string;
  role: string;
  createdAt: string;
  lastSignInTime: string | null;
};

export type AllowedEmailWithoutUserEntry = {
  allowedEmailId: string;
  email: string;
};

export type InvalidEntry = {
  kind: "user" | "allowed_email";
  id: string;
  reason: string;
};

export type ExcludedSuperAdminEntry = {
  userId: string;
  email: string;
};

export type AuditReport = {
  matched: MatchedEntry[];
  usersWithoutAllowedEmail: UserWithoutAllowedEmailEntry[];
  allowedEmailsWithoutUser: AllowedEmailWithoutUserEntry[];
  invalid: InvalidEntry[];
  excludedSuperAdmins: ExcludedSuperAdminEntry[];
};

function normalizeEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  return normalizeEmailUtil(raw);
}

/**
 * users / allowed_emails / スーパー管理者リストを突き合わせて監査レポートを生成。
 *
 * @param users そのテナントの users コレクション内容
 * @param allowedEmails そのテナントの allowed_emails コレクション内容
 * @param superAdminEmails 正規化済みのスーパー管理者メール集合（env + Firestore + 手動）
 */
export function planAudit(
  users: AuditUserInput[],
  allowedEmails: AuditAllowedEmailInput[],
  superAdminEmails: Iterable<string>
): AuditReport {
  const superAdminSet = new Set<string>();
  for (const email of superAdminEmails) {
    const n = normalizeEmail(email);
    if (n) superAdminSet.add(n);
  }

  const allowedByNormalized = new Map<string, AuditAllowedEmailInput>();
  const invalid: InvalidEntry[] = [];

  for (const ae of allowedEmails) {
    const n = normalizeEmail(ae.email);
    if (!n) {
      invalid.push({
        kind: "allowed_email",
        id: ae.id,
        reason: "email が空または null",
      });
      continue;
    }
    if (!allowedByNormalized.has(n)) {
      allowedByNormalized.set(n, ae);
    }
  }

  const usersByNormalized = new Map<string, AuditUserInput>();
  for (const u of users) {
    const n = normalizeEmail(u.email);
    if (!n) {
      invalid.push({
        kind: "user",
        id: u.id,
        reason: "email が空または null",
      });
      continue;
    }
    if (!usersByNormalized.has(n)) {
      usersByNormalized.set(n, u);
    }
  }

  const matched: MatchedEntry[] = [];
  const usersWithoutAllowedEmail: UserWithoutAllowedEmailEntry[] = [];
  const excludedSuperAdmins: ExcludedSuperAdminEntry[] = [];

  for (const [n, u] of usersByNormalized) {
    const ae = allowedByNormalized.get(n);
    if (ae) {
      matched.push({
        userId: u.id,
        firebaseUid: u.firebaseUid,
        email: n,
        allowedEmailId: ae.id,
      });
      continue;
    }

    if (superAdminSet.has(n)) {
      excludedSuperAdmins.push({ userId: u.id, email: n });
      continue;
    }

    usersWithoutAllowedEmail.push({
      userId: u.id,
      firebaseUid: u.firebaseUid,
      email: n,
      role: u.role,
      createdAt: u.createdAt,
      lastSignInTime: u.lastSignInTime ?? null,
    });
  }

  const allowedEmailsWithoutUser: AllowedEmailWithoutUserEntry[] = [];
  for (const [n, ae] of allowedByNormalized) {
    if (!usersByNormalized.has(n)) {
      allowedEmailsWithoutUser.push({
        allowedEmailId: ae.id,
        email: n,
      });
    }
  }

  return {
    matched,
    usersWithoutAllowedEmail,
    allowedEmailsWithoutUser,
    invalid,
    excludedSuperAdmins,
  };
}

/**
 * `--fix` で allowed_emails に追加する際の note 文字列を生成する。
 * Issue #279 の決定: `audit-fix (Issue #279) by scripts/audit-users-vs-allowed-emails on YYYY-MM-DD`
 *
 * @param date 基準日時（テスト可能性のため注入可能）
 */
export function buildAuditFixNote(date: Date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `audit-fix (Issue #279) by scripts/audit-users-vs-allowed-emails on ${yyyy}-${mm}-${dd}`;
}
