#!/usr/bin/env npx tsx
/**
 * allowed_emails 棚卸しスクリプト（Issue #279）
 *
 * 目的:
 *   Issue #278（既存 users 経路にも allowlist 再チェックを追加）を本番デプロイする前に、
 *   「users レコードは存在するが allowed_emails に登録されていない」ユーザーを検出する。
 *   これを怠ると本番デプロイ直後に、許可すべき既存ユーザーが一斉に弾かれる。
 *
 * 分類:
 *   ✅ matched                     users と allowed_emails の両方にある
 *   ⚠️ usersWithoutAllowedEmail    users にあるが allowed_emails にない → 補正候補
 *   🟡 allowedEmailsWithoutUser   allowed_emails にあるが users にない（招待済み未ログイン）
 *   ❌ invalid                     email が空/null の不正データ
 *   🟢 excludedSuperAdmins         スーパー管理者は補正対象外（判定参考に出力）
 *
 * 実行モード:
 *   dry-run (既定)                  書き込みなし、レポートのみ
 *   --fix                           書き込み候補を表示（dry-run のまま）
 *   --fix --execute                 ⚠️グループを allowed_emails に追加
 *
 * スーパー管理者判定:
 *   環境変数 SUPER_ADMIN_EMAILS + Firestore superAdmins コレクション + --super-admins で指定した値
 *   の union を補正対象外とする（services/api/src/middleware/super-admin.ts の実効判定と一致）
 *
 * 使用方法:
 *   npx tsx scripts/audit-users-vs-allowed-emails.ts                            # 全テナント dry-run
 *   npx tsx scripts/audit-users-vs-allowed-emails.ts --tenant t1                # 特定テナント
 *   npx tsx scripts/audit-users-vs-allowed-emails.ts --super-admins a@x,b@x     # 手動追加
 *   npx tsx scripts/audit-users-vs-allowed-emails.ts --skip-auth-metadata       # lastSignInTime 取得スキップ
 *   npx tsx scripts/audit-users-vs-allowed-emails.ts --fix --execute            # 一括補正
 *
 * 環境変数:
 *   GOOGLE_APPLICATION_CREDENTIALS  サービスアカウント JSON のパス
 *   FIREBASE_PROJECT_ID             プロジェクト ID（省略時は ADC から解決）
 *   SUPER_ADMIN_EMAILS              スーパー管理者メール（カンマ区切り）
 */

import {
  initializeApp,
  cert,
  getApps,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type WriteBatch } from "firebase-admin/firestore";
import {
  planAudit,
  buildAuditFixNote,
  type AuditUserInput,
  type AuditAllowedEmailInput,
  type AuditReport,
} from "../services/api/src/services/allowed-email-audit.js";
import { toISOOptional } from "../services/api/src/datasource/firestore.js";

type CliOptions = {
  fix: boolean;
  execute: boolean;
  skipAuthMetadata: boolean;
  tenantFilter: string | null;
  extraSuperAdmins: string[];
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fix: false,
    execute: false,
    skipAuthMetadata: false,
    tenantFilter: null,
    extraSuperAdmins: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--fix":
        options.fix = true;
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--skip-auth-metadata":
        options.skipAuthMetadata = true;
        break;
      case "--tenant": {
        const val = argv[++i];
        if (!val) throw new Error("--tenant の値が指定されていません");
        options.tenantFilter = val;
        break;
      }
      case "--super-admins": {
        const val = argv[++i];
        if (!val) throw new Error("--super-admins の値が指定されていません");
        options.extraSuperAdmins = val
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      }
      case "--help":
      case "-h":
        console.log(
          "使い方は scripts/audit-users-vs-allowed-emails.ts 冒頭のコメントを参照してください。"
        );
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        // `--tenant` を忘れて位置引数だけ渡すと全テナント走査に巻き込まれる事故を防ぐため、
        // 未知の引数（オプション形式でないものも含む）は明示的にエラーにする。
        throw new Error(`未知の引数: ${arg}`);
    }
  }

  return options;
}

function initializeFirebase(): void {
  if (getApps().length > 0) return;

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const serviceAccount = require(credPath) as ServiceAccount;
    initializeApp({ credential: cert(serviceAccount) });
  } else {
    initializeApp();
  }
}

/**
 * 環境変数 + Firestore ルート superAdmins コレクション + 手動追加分の union を返す。
 * middleware/super-admin.ts の getAllSuperAdmins と同じ情報源。
 *
 * strict=true（--execute 時）の場合は Firestore 取得失敗で throw する。
 * これによりスーパー管理者のメールが誤って tenant の allowed_emails に追加される
 * セキュリティモデル汚染を防ぐ（Evaluator HIGH 指摘）。
 */
async function collectSuperAdmins(
  extra: string[],
  strict: boolean
): Promise<string[]> {
  const result = new Set<string>();

  const envCsv = process.env.SUPER_ADMIN_EMAILS ?? "";
  for (const email of envCsv.split(",")) {
    const n = email.trim().toLowerCase();
    if (n) result.add(n);
  }

  try {
    const db = getFirestore();
    const snapshot = await db.collection("superAdmins").get();
    for (const doc of snapshot.docs) {
      result.add(doc.id.toLowerCase());
    }
  } catch (error) {
    if (strict) {
      throw new Error(
        `Firestore superAdmins コレクション取得失敗（--execute 時は fatal）: ${String(error)}`
      );
    }
    console.warn(
      `⚠️  Firestore superAdmins コレクションの取得に失敗しました（dry-run のため続行）: ${String(error)}`
    );
  }

  for (const email of extra) {
    const n = email.trim().toLowerCase();
    if (n) result.add(n);
  }

  return Array.from(result).sort();
}

/**
 * users に firebaseUid がある場合、Firebase Auth から lastSignInTime をバッチ取得する。
 * getUsers は最大 100 件/リクエスト。
 */
async function enrichUsersWithAuthMetadata(
  users: AuditUserInput[]
): Promise<AuditUserInput[]> {
  const uids = Array.from(
    new Set(
      users
        .map((u) => u.firebaseUid)
        .filter((uid): uid is string => typeof uid === "string" && uid.length > 0)
    )
  );
  if (uids.length === 0) return users;

  const lastSignInByUid = new Map<string, string>();
  const auth = getAuth();

  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    try {
      const result = await auth.getUsers(chunk.map((uid) => ({ uid })));
      for (const user of result.users) {
        const t = user.metadata?.lastSignInTime;
        if (t) lastSignInByUid.set(user.uid, t);
      }
    } catch (error) {
      console.warn(
        `⚠️  Firebase Auth getUsers バッチ取得に失敗（続行）: ${String(error)}`
      );
    }
  }

  return users.map((u) => ({
    ...u,
    lastSignInTime: u.firebaseUid
      ? (lastSignInByUid.get(u.firebaseUid) ?? null)
      : null,
  }));
}

function printTenantReport(tenantId: string, report: AuditReport): void {
  console.log(`\n=== Tenant: ${tenantId} ===`);
  console.log(
    `  matched                     : ${report.matched.length}`
  );
  console.log(
    `  usersWithoutAllowedEmail ⚠️  : ${report.usersWithoutAllowedEmail.length}`
  );
  console.log(
    `  allowedEmailsWithoutUser    : ${report.allowedEmailsWithoutUser.length}`
  );
  console.log(
    `  invalid                     : ${report.invalid.length}`
  );
  console.log(
    `  excludedSuperAdmins         : ${report.excludedSuperAdmins.length}`
  );

  if (report.usersWithoutAllowedEmail.length > 0) {
    console.log("\n  ⚠️  補正候補（users にあるが allowed_emails にない）:");
    for (const e of report.usersWithoutAllowedEmail) {
      console.log(
        `    - email=${e.email} role=${e.role} userId=${e.userId} firebaseUid=${e.firebaseUid ?? "(none)"} createdAt=${e.createdAt} lastSignInTime=${e.lastSignInTime ?? "unknown"}`
      );
    }
  }

  if (report.allowedEmailsWithoutUser.length > 0) {
    console.log("\n  🟡 allowed_emails にあるが users にない（招待済み未ログイン）:");
    for (const e of report.allowedEmailsWithoutUser) {
      console.log(`    - email=${e.email} allowedEmailId=${e.allowedEmailId}`);
    }
  }

  if (report.invalid.length > 0) {
    console.log("\n  ❌ 不正データ（email が空/null）:");
    for (const e of report.invalid) {
      console.log(`    - kind=${e.kind} id=${e.id} reason=${e.reason}`);
    }
  }

  if (report.excludedSuperAdmins.length > 0) {
    console.log("\n  🟢 スーパー管理者（補正対象外）:");
    for (const e of report.excludedSuperAdmins) {
      console.log(`    - email=${e.email} userId=${e.userId}`);
    }
  }
}

/**
 * Firestore WriteBatch の上限は 500 件/commit。
 * 未定義動作を避けるため安全マージンを取って 450 件で切り替える。
 */
const WRITE_BATCH_LIMIT = 450;

type ApplyFixResult = {
  applied: number;
  skippedExisting: number;
};

/**
 * ⚠️ グループを allowed_emails に追加する。
 *
 * 重複追加防止（TOCTOU ウィンドウ最小化）:
 *   applyFix 直前に allowed_emails コレクションを再取得し、
 *   正規化済み email で Set 照合して既存エントリはスキップする。
 *
 * アトミシティ:
 *   WriteBatch で束ねてコミットすることで、ネットワーク往復の削減と
 *   同一バッチ内の原子性を確保する（Firestore は 500 件/commit 上限）。
 */
async function applyFix(
  tenantId: string,
  report: AuditReport,
  note: string,
  execute: boolean
): Promise<ApplyFixResult> {
  if (report.usersWithoutAllowedEmail.length === 0) {
    return { applied: 0, skippedExisting: 0 };
  }

  const db = getFirestore();

  const currentSnap = await db
    .collection(`tenants/${tenantId}/allowed_emails`)
    .get();
  const existingEmails = new Set<string>();
  for (const doc of currentSnap.docs) {
    const email = doc.data().email;
    if (typeof email === "string") {
      const n = email.trim().toLowerCase();
      if (n) existingEmails.add(n);
    }
  }

  const pendingBatches: WriteBatch[] = [];
  let currentBatch = db.batch();
  let opCount = 0;
  let applied = 0;
  let skippedExisting = 0;

  // entry.email は planAudit が normalizeEmail で正規化した値。
  // existingEmails 側も同じ規則で正規化済みのため、直接比較してよい。
  for (const entry of report.usersWithoutAllowedEmail) {
    if (existingEmails.has(entry.email)) {
      console.log(
        `[SKIP EXISTING] tenant=${tenantId} email=${entry.email} (既に allowed_emails に存在)`
      );
      skippedExisting++;
      continue;
    }

    console.log(
      `[FIX] tenant=${tenantId} add allowed_email email=${entry.email} userId=${entry.userId}`
    );

    if (execute) {
      const ref = db.collection(`tenants/${tenantId}/allowed_emails`).doc();
      currentBatch.set(ref, {
        email: entry.email,
        note,
        createdAt: new Date(),
      });
      opCount++;
      applied++;
      existingEmails.add(entry.email); // 同一 run 内での重複防止

      if (opCount >= WRITE_BATCH_LIMIT) {
        pendingBatches.push(currentBatch);
        currentBatch = db.batch();
        opCount = 0;
      }
    }
  }

  if (execute && opCount > 0) {
    pendingBatches.push(currentBatch);
  }

  for (let i = 0; i < pendingBatches.length; i++) {
    try {
      await pendingBatches[i].commit();
    } catch (error) {
      console.error(
        `[BATCH FAILED] tenant=${tenantId} batch=${i + 1}/${pendingBatches.length} (既にコミット済みのバッチはロールバックされません): ${String(error)}`
      );
      throw error;
    }
  }

  return { applied, skippedExisting };
}

/**
 * 同一 email を持つ users レコードが複数ある場合に警告を出す。
 * planAudit は最初の 1 件のみ採用して後続を無視するため、実態の把握には
 * 事前にこの警告を出すことが重要（Evaluator エッジケース指摘）。
 */
function warnDuplicateUsers(
  tenantId: string,
  rawUsers: AuditUserInput[]
): void {
  const byEmail = new Map<string, string[]>();
  for (const u of rawUsers) {
    const n = (u.email ?? "").trim().toLowerCase();
    if (!n) continue;
    const ids = byEmail.get(n) ?? [];
    ids.push(u.id);
    byEmail.set(n, ids);
  }
  for (const [email, ids] of byEmail) {
    if (ids.length > 1) {
      console.warn(
        `⚠️  [DUPLICATE USERS] tenant=${tenantId} email=${email} userIds=${ids.join(",")} (2件目以降は planAudit で無視されます)`
      );
    }
  }
}

async function main(options: CliOptions): Promise<void> {
  if (options.execute && !options.fix) {
    throw new Error(
      "--execute は --fix と併用する必要があります。補正なしの dry-run なら --execute を外してください。"
    );
  }

  initializeFirebase();
  const db = getFirestore();

  const writeMode = options.fix && options.execute;
  const header = `=== audit-users-vs-allowed-emails (${writeMode ? "EXECUTE" : "DRY-RUN"}${options.fix ? " + FIX" : ""}) ===`;
  console.log(header);
  console.log(`Issue: #279`);
  console.log(`Date : ${new Date().toISOString()}`);
  if (options.tenantFilter) {
    console.log(`Filter: tenant=${options.tenantFilter}`);
  }

  const superAdmins = await collectSuperAdmins(
    options.extraSuperAdmins,
    writeMode
  );
  console.log(`SuperAdmins (union): ${superAdmins.length} 件`);
  if (superAdmins.length === 0) {
    console.warn(
      "⚠️  スーパー管理者が1件も検出されませんでした。SUPER_ADMIN_EMAILS 環境変数と Firestore superAdmins コレクションを確認してください。"
    );
  }

  const tenantsSnap = await db.collection("tenants").get();
  const targetTenants = options.tenantFilter
    ? tenantsSnap.docs.filter((d) => d.id === options.tenantFilter)
    : tenantsSnap.docs;

  if (targetTenants.length === 0) {
    console.warn("⚠️  対象テナントが見つかりませんでした。");
    return;
  }

  const note = buildAuditFixNote();
  let totalUsersWithoutAllowedEmail = 0;
  let totalApplied = 0;
  let totalSkippedExisting = 0;
  const tenantsWithDiff: string[] = [];

  for (const tenantDoc of targetTenants) {
    const tenantId = tenantDoc.id;

    const [usersSnap, allowedSnap] = await Promise.all([
      db.collection(`tenants/${tenantId}/users`).get(),
      db.collection(`tenants/${tenantId}/allowed_emails`).get(),
    ]);

    const rawUsers: AuditUserInput[] = usersSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        email: (data.email as string | null | undefined) ?? null,
        firebaseUid: (data.firebaseUid as string | undefined) ?? undefined,
        role: (data.role as string | undefined) ?? "student",
        createdAt: toISOOptional(data.createdAt) ?? "unknown",
      };
    });

    warnDuplicateUsers(tenantId, rawUsers);

    const users = options.skipAuthMetadata
      ? rawUsers.map((u) => ({ ...u, lastSignInTime: null }))
      : await enrichUsersWithAuthMetadata(rawUsers);

    const allowedEmails: AuditAllowedEmailInput[] = allowedSnap.docs.map((d) => ({
      id: d.id,
      email: (d.data().email as string | null | undefined) ?? null,
    }));

    const report = planAudit(users, allowedEmails, superAdmins);
    printTenantReport(tenantId, report);

    totalUsersWithoutAllowedEmail += report.usersWithoutAllowedEmail.length;
    if (report.usersWithoutAllowedEmail.length > 0) {
      tenantsWithDiff.push(tenantId);
    }

    if (options.fix) {
      const { applied, skippedExisting } = await applyFix(
        tenantId,
        report,
        note,
        options.execute
      );
      totalApplied += applied;
      totalSkippedExisting += skippedExisting;
    }
  }

  console.log("\n=== Summary ===");
  console.log(`scanned tenants                : ${targetTenants.length}`);
  console.log(`tenants with diff              : ${tenantsWithDiff.length}`);
  if (tenantsWithDiff.length > 0) {
    console.log(`  -> ${tenantsWithDiff.join(", ")}`);
  }
  console.log(
    `totalUsersWithoutAllowedEmail  : ${totalUsersWithoutAllowedEmail}`
  );

  if (options.fix) {
    if (options.execute) {
      console.log(`allowed_emails added (executed): ${totalApplied}`);
      console.log(`skipped (already existed)      : ${totalSkippedExisting}`);
    } else {
      console.log(
        `allowed_emails would add        : ${totalUsersWithoutAllowedEmail - totalSkippedExisting} (re-run with --execute to apply)`
      );
      console.log(`skipped (already existed)      : ${totalSkippedExisting}`);
    }
  } else if (totalUsersWithoutAllowedEmail > 0) {
    console.log(
      "\n次のステップ: レポートの⚠️リストを人手レビュー（退職者等を除外）→ 必要なら --fix --execute で補正。"
    );
  }
}

// CLI 実行時のみ main を呼ぶ（import 時は副作用なし）
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("audit-users-vs-allowed-emails.ts");

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    main(options).catch((err) => {
      console.error("audit-users-vs-allowed-emails failed:", err);
      process.exit(1);
    });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}
