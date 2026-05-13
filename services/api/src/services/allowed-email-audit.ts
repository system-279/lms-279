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

/**
 * 正規化済みメールアドレスを表す brand 型 (Issue #281)。
 *
 * `toNormalizedEmail()` を通った文字列のみが NormalizedEmail として扱える。
 * MatchedEntry.email 等が `email.toLowerCase().trim()` 済みであることを型レベルで保証し、
 * 未正規化文字列が直接代入されることをコンパイル時に防ぐ。
 *
 * 実体は string だが、unique symbol を持つ phantom field で区別する。
 */
declare const __NormalizedEmailBrand: unique symbol;
export type NormalizedEmail = string & {
  readonly [__NormalizedEmailBrand]: void;
};

/**
 * 任意文字列を NormalizedEmail に変換する。
 * 空文字 / null / undefined / 正規化後が空文字なら null を返す。
 */
export function toNormalizedEmail(
  raw: string | null | undefined
): NormalizedEmail | null {
  if (!raw) return null;
  const n = normalizeEmailUtil(raw);
  return n.length > 0 ? (n as NormalizedEmail) : null;
}

/**
 * CLI 実行モード (Issue #281)。
 *
 * 旧 `{ fix: boolean; execute: boolean }` の組み合わせ 4 通りのうち、
 * `{ fix: false, execute: true }`（補正なしで書き込みのみ）は意味的に不正な状態だったが、
 * 旧型ではコンパイル時に防げず runtime チェックに依存していた。
 *
 * 3 状態の discriminated union 化で `--execute` 単体を型レベルで排除する。
 */
export type AuditMode =
  | { kind: "dry-run" }
  | { kind: "fix-dry-run" }
  | { kind: "fix-execute" };

export type CliOptions = {
  mode: AuditMode;
  skipAuthMetadata: boolean;
  tenantFilter: string | null;
  extraSuperAdmins: string[];
};

export type AuditUserInput = {
  id: string;
  email: string | null | undefined;
  firebaseUid?: string;
  role: string;
  createdAt: string;
  /**
   * Firebase Auth から取得した最終サインイン時刻。取得不可なら null。
   * Issue #281: optional を撤廃し必須化 (silent failure 防止)。
   */
  lastSignInTime: string | null;
};

export type AuditAllowedEmailInput = {
  id: string;
  email: string | null | undefined;
};

export type MatchedEntry = {
  userId: string;
  firebaseUid?: string;
  email: NormalizedEmail;
  allowedEmailId: string;
};

export type UserWithoutAllowedEmailEntry = {
  userId: string;
  firebaseUid?: string;
  email: NormalizedEmail;
  role: string;
  createdAt: string;
  lastSignInTime: string | null;
};

export type AllowedEmailWithoutUserEntry = {
  allowedEmailId: string;
  email: NormalizedEmail;
};

export type InvalidEntry = {
  kind: "user" | "allowed_email";
  id: string;
  reason: string;
};

export type ExcludedSuperAdminEntry = {
  userId: string;
  email: NormalizedEmail;
};

/**
 * Issue #281: 同一 email を持つ users レコードが複数ある場合の可視化エントリ。
 * planAudit は最初の 1 件のみ採用するため、ここで漏れを可視化する。
 */
export type DuplicateUserEntry = {
  email: NormalizedEmail;
  userIds: string[];
};

export type AuditReport = {
  matched: MatchedEntry[];
  usersWithoutAllowedEmail: UserWithoutAllowedEmailEntry[];
  allowedEmailsWithoutUser: AllowedEmailWithoutUserEntry[];
  invalid: InvalidEntry[];
  excludedSuperAdmins: ExcludedSuperAdminEntry[];
  /** Issue #281: 同一 email が複数 users にある場合、最初の 1 件以外はここに可視化 */
  duplicateUsers: DuplicateUserEntry[];
};

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
  const superAdminSet = new Set<NormalizedEmail>();
  for (const email of superAdminEmails) {
    const n = toNormalizedEmail(email);
    if (n !== null) superAdminSet.add(n);
  }

  const allowedByNormalized = new Map<NormalizedEmail, AuditAllowedEmailInput>();
  const invalid: InvalidEntry[] = [];

  for (const ae of allowedEmails) {
    const n = toNormalizedEmail(ae.email);
    if (n === null) {
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

  // Issue #281: 重複 users を可視化するため、最初の 1 件を採用 + 後続を duplicateUserIds に記録
  const usersByNormalized = new Map<NormalizedEmail, AuditUserInput>();
  const duplicateUserIds = new Map<NormalizedEmail, string[]>();
  for (const u of users) {
    const n = toNormalizedEmail(u.email);
    if (n === null) {
      invalid.push({
        kind: "user",
        id: u.id,
        reason: "email が空または null",
      });
      continue;
    }
    if (!usersByNormalized.has(n)) {
      usersByNormalized.set(n, u);
    } else {
      const list = duplicateUserIds.get(n) ?? [];
      list.push(u.id);
      duplicateUserIds.set(n, list);
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
      lastSignInTime: u.lastSignInTime,
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

  // primary (採用) + 漏れた N 件 を 1 entry に集約して全体像を保つ。
  // duplicateUserIds に entry がある email は usersByNormalized にも primary がいる前提。
  const duplicateUsers: DuplicateUserEntry[] = [];
  for (const [n, droppedIds] of duplicateUserIds) {
    const primary = usersByNormalized.get(n)!;
    duplicateUsers.push({ email: n, userIds: [primary.id, ...droppedIds] });
  }

  return {
    matched,
    usersWithoutAllowedEmail,
    allowedEmailsWithoutUser,
    invalid,
    excludedSuperAdmins,
    duplicateUsers,
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

/** Firestore WriteBatch の commit 上限（公式: 500 op / batch、本スクリプトは set のみで安全側 450）。 */
export const WRITE_BATCH_LIMIT = 450;

/**
 * Issue #281: `--fix` 実行計画の純粋ロジック。
 *
 * `report.usersWithoutAllowedEmail` から `existingEmails` を引いた差分を「追加対象」とし、
 * 既存に同じ email がある entry は `toSkip` として分離。さらに WriteBatch の op 上限
 * ({@link WRITE_BATCH_LIMIT}) でバッチ分割し、`batches` に email 配列の配列を返す。
 *
 * Firestore IO は scripts 側で `db.batch().set(...)` を実行する。本関数は純粋。
 *
 * 同一 batch 内の重複 (同じ entry を 2 回 push) は planAudit 側で発生しないため、ここでは
 * 防御しない（早期発見のため duplicate を引数で受けたら throw する選択肢もあるが、現状
 * 不要）。
 */
export type ApplyFixPlan = {
  toAdd: NormalizedEmail[];
  toSkip: NormalizedEmail[];
  batches: NormalizedEmail[][];
};

export function planApplyFix(
  report: Pick<AuditReport, "usersWithoutAllowedEmail">,
  existingEmails: Iterable<NormalizedEmail>,
  batchLimit: number = WRITE_BATCH_LIMIT
): ApplyFixPlan {
  if (batchLimit <= 0) {
    throw new Error(`batchLimit must be positive (got ${batchLimit})`);
  }

  const existingSet = new Set<NormalizedEmail>(existingEmails);
  const toAdd: NormalizedEmail[] = [];
  const toSkip: NormalizedEmail[] = [];
  // O(1) lookup でループ内重複を排除（901+ 件のテストで O(n²) を回避）
  const toAddSet = new Set<NormalizedEmail>();

  for (const entry of report.usersWithoutAllowedEmail) {
    if (existingSet.has(entry.email)) {
      toSkip.push(entry.email);
      continue;
    }
    if (toAddSet.has(entry.email)) continue;
    toAddSet.add(entry.email);
    toAdd.push(entry.email);
  }

  const batches: NormalizedEmail[][] = [];
  for (let i = 0; i < toAdd.length; i += batchLimit) {
    batches.push(toAdd.slice(i, i + batchLimit));
  }

  return { toAdd, toSkip, batches };
}

/**
 * Issue #281: env CSV + Firestore emails + 手動追加分の union 計算 (純粋関数)。
 *
 * Firestore 取得は scripts 側で行う。本関数は文字列入力のみで純粋。
 * 各入力は trim().toLowerCase() で正規化され、空文字は除去される。結果はソート済み。
 */
export function mergeSuperAdmins(
  envCsv: string,
  firestoreEmails: Iterable<string>,
  extra: Iterable<string>
): NormalizedEmail[] {
  const result = new Set<NormalizedEmail>();

  const pushAll = (source: Iterable<string>): void => {
    for (const raw of source) {
      const n = toNormalizedEmail(raw);
      if (n !== null) result.add(n);
    }
  };

  pushAll(envCsv.split(","));
  pushAll(firestoreEmails);
  pushAll(extra);

  return Array.from(result).sort();
}

/**
 * Issue #281: CLI 引数パース (純粋関数)。
 *
 * - 位置引数 (`--` 接頭辞なし) は明示的に reject。
 * - `--execute` 単体（`--fix` 未指定）は reject。
 * - `--tenant` / `--super-admins` の値欠落も reject。
 * - 戻り値の {@link CliOptions.mode} は discriminated union 化済 (旧 `fix/execute` boolean ペア廃止)。
 *
 * `--help` / `-h` は scripts 側で I/O 込みでハンドリングするため、本関数では `kind: "help"`
 * を返さず、`HelpRequestedError` でフロー制御する。
 */
export class HelpRequestedError extends Error {
  constructor() {
    super("HELP_REQUESTED");
    this.name = "HelpRequestedError";
  }
}

export function parseAuditArgs(argv: readonly string[]): CliOptions {
  let fix = false;
  let execute = false;
  let skipAuthMetadata = false;
  let tenantFilter: string | null = null;
  let extraSuperAdmins: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--fix":
        fix = true;
        break;
      case "--execute":
        execute = true;
        break;
      case "--skip-auth-metadata":
        skipAuthMetadata = true;
        break;
      case "--tenant": {
        const val = argv[++i];
        if (!val) throw new Error("--tenant の値が指定されていません");
        tenantFilter = val;
        break;
      }
      case "--super-admins": {
        const val = argv[++i];
        if (!val) throw new Error("--super-admins の値が指定されていません");
        extraSuperAdmins = val
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      }
      case "--help":
      case "-h":
        throw new HelpRequestedError();
      default:
        // `--tenant` を忘れて位置引数だけ渡すと全テナント走査に巻き込まれる事故を防ぐため、
        // 未知の引数（オプション形式でないものも含む）は明示的にエラーにする。
        throw new Error(`未知の引数: ${arg}`);
    }
  }

  if (execute && !fix) {
    throw new Error(
      "--execute は --fix と併用する必要があります。補正なしの dry-run なら --execute を外してください。"
    );
  }

  // execute && !fix は上で reject 済み。残るのは 3 状態のみ。
  let mode: AuditMode;
  if (execute) {
    mode = { kind: "fix-execute" };
  } else if (fix) {
    mode = { kind: "fix-dry-run" };
  } else {
    mode = { kind: "dry-run" };
  }

  return { mode, skipAuthMetadata, tenantFilter, extraSuperAdmins };
}

/**
 * Issue #281: 同一 email を持つ users レコードを検出する純粋関数。
 *
 * planAudit も内部で重複検出するが、`AuditUserInput` の段階で early-warn したい
 * （scripts は planAudit 呼び出し前に console.warn を出すフロー）ために独立した関数を提供。
 */
export function detectDuplicateUsers(
  rawUsers: readonly AuditUserInput[]
): DuplicateUserEntry[] {
  const byEmail = new Map<NormalizedEmail, string[]>();
  for (const u of rawUsers) {
    const n = toNormalizedEmail(u.email);
    if (n === null) continue;
    const ids = byEmail.get(n) ?? [];
    ids.push(u.id);
    byEmail.set(n, ids);
  }
  const result: DuplicateUserEntry[] = [];
  for (const [email, userIds] of byEmail) {
    if (userIds.length > 1) {
      result.push({ email, userIds });
    }
  }
  return result;
}
