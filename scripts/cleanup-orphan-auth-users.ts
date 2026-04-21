#!/usr/bin/env npx tsx
/**
 * 孤児Firebase Authユーザー掃除スクリプト（Phase 1.7 / ADR-031）
 *
 * OAuth同意画面のExternal化（ADR-031のPhase 1）により、全世界のGoogleユーザーが
 * Firebase Authにユーザーレコードを作成できる状態となる。アプリ側ではallowed_emailsで
 * 認可制御しているため実害はないが、長期的にはFirebase Authに未所属ユーザーが蓄積する。
 *
 * 本スクリプトは allowed_emails + users コレクションに登録されていない Firebase Auth
 * ユーザー（孤児）を安全に削除する。
 *
 * 安全機構（PR #273 レビュー結果反映）:
 * 1. dry-run既定（--execute で実行）
 * 2. tenants空 / 取得メール0件を異常事態として中断（全ユーザー削除誤動作防止）
 * 3. --min-age-seconds（既定3600=1時間）未満のユーザーは対象外（ログイン直後の誤削除防止）
 * 4. disabledユーザーはデフォルトスキップ（調査中・懲罰中等の中間状態を保護）
 * 5. 連続失敗閾値（--fail-streak、既定3）で即座に中断
 * 6. 削除前のバックアップJSON出力
 * 7. エラーコード別分岐（auth/insufficient-permission → 致命、auth/user-not-found → スキップ）
 * 8. creationTime の NaN チェック（min-age バイパス防止）
 *
 * ⚠️ GCIP移行期間中の注意（ADR-031 Phase 3 段階展開中）:
 *   本スクリプトは `getAuth()` のデフォルトインスタンスのみを対象とし、
 *   GCIP Tenant 配下のユーザーは対象外。feature flag `useGcip: true` のテナントに
 *   所属するユーザーは GCIP tenant auth に移動しているため、本スクリプトで孤児判定
 *   されない。Phase 3 完了時に `tenantManager().authForTenant(gcipTenantId)` 対応を
 *   追加する（Phase 5 で正式化）。
 *
 * 運用: 週次 or 月次で実行想定（Phase 5で Cloud Scheduler に正式化）
 *
 * 使用方法:
 *   # dry-run (既定)
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/cleanup-orphan-auth-users.ts
 *
 *   # 実削除
 *   npx tsx scripts/cleanup-orphan-auth-users.ts --execute
 *
 *   # オプション
 *   --min-age-seconds=86400   削除対象の最小経過時間（既定3600、最小60）
 *   --include-disabled        disabledユーザーも対象に含める（既定スキップ）
 *   --fail-streak=5           連続失敗中断閾値（既定3、最小1）
 */

import {
  initializeApp,
  cert,
  applicationDefault,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ---------- 定数 ----------
const KNOWN_FLAGS = [
  "--execute",
  "--include-disabled",
  "--min-age-seconds=",
  "--fail-streak=",
];
const MIN_ALLOWED_MIN_AGE_SEC = 60;

// ---------- 引数パース ----------
const args = process.argv.slice(2);

// 未知フラグ検知（typo による silent failure 防止）
const unknownArgs = args.filter(
  (a) => !KNOWN_FLAGS.some((k) => a === k || a.startsWith(k))
);
if (unknownArgs.length > 0) {
  console.error(`[FATAL] 未知のフラグ: ${unknownArgs.join(", ")}`);
  console.error(`  既知のフラグ: ${KNOWN_FLAGS.join(" / ")}`);
  process.exit(1);
}

const EXECUTE = args.includes("--execute");
const INCLUDE_DISABLED = args.includes("--include-disabled");

const rawMinAge = args
  .find((a) => a.startsWith("--min-age-seconds="))
  ?.split("=")[1];
const MIN_AGE_SEC = rawMinAge !== undefined ? Number(rawMinAge) : 3600;
if (!Number.isFinite(MIN_AGE_SEC) || MIN_AGE_SEC < MIN_ALLOWED_MIN_AGE_SEC) {
  console.error(
    `[FATAL] --min-age-seconds は${MIN_ALLOWED_MIN_AGE_SEC}以上の数値が必要です: 受け取った値="${rawMinAge}"`
  );
  process.exit(1);
}

const rawFailStreak = args
  .find((a) => a.startsWith("--fail-streak="))
  ?.split("=")[1];
const FAIL_ABORT_STREAK =
  rawFailStreak !== undefined ? Number(rawFailStreak) : 3;
if (!Number.isFinite(FAIL_ABORT_STREAK) || FAIL_ABORT_STREAK < 1) {
  console.error(
    `[FATAL] --fail-streak は1以上の数値が必要です: 受け取った値="${rawFailStreak}"`
  );
  process.exit(1);
}

// ---------- Firebase初期化 ----------
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
try {
  if (credPath) {
    // ServiceAccount JSON は絶対パスまたは CWD 基準で解決
    const jsonPath = resolve(process.cwd(), credPath);
    const serviceAccount = JSON.parse(
      readFileSync(jsonPath, "utf8")
    ) as ServiceAccount;
    initializeApp({ credential: cert(serviceAccount) });
    console.log(`認証: サービスアカウントJSON (${jsonPath})`);
  } else {
    initializeApp({ credential: applicationDefault() });
    console.log("認証: Application Default Credentials");
  }
} catch (err) {
  console.error(
    `[FATAL] Firebase初期化失敗 (credPath=${credPath ?? "ADC"}): ${
      err instanceof Error ? err.message : err
    }`
  );
  process.exit(1);
}

const db = getFirestore();
const auth = getAuth();

// ---------- ユーティリティ ----------
// アプリ側（tenant-auth.ts）は toLowerCase のみだが、掃除時は誤判定防止のため trim も実施
const normalizeEmail = (email: string | undefined): string =>
  (email ?? "").trim().toLowerCase();

// ---------- 集約 ----------
async function collectAllowedAndRegisteredEmails(): Promise<Set<string>> {
  const emails = new Set<string>();
  const tenantsSnap = await db.collection("tenants").get();

  // SAFEGUARD 1: tenants が空 → 異常事態として中断
  if (tenantsSnap.empty) {
    throw new Error(
      "ABORT: tenants コレクションが空です。プロジェクトID/権限設定を確認してください。" +
        "この状態で削除を継続すると全Authユーザーを誤削除します。"
    );
  }

  let tenantsProcessed = 0;
  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;
    try {
      const allowedSnap = await db
        .collection(`tenants/${tenantId}/allowed_emails`)
        .get();
      for (const doc of allowedSnap.docs) {
        const email = normalizeEmail(doc.data().email);
        if (email) emails.add(email);
      }
      const usersSnap = await db
        .collection(`tenants/${tenantId}/users`)
        .get();
      for (const doc of usersSnap.docs) {
        const email = normalizeEmail(doc.data().email);
        if (email) emails.add(email);
      }
      tenantsProcessed++;
    } catch (err) {
      throw new Error(
        `テナント ${tenantId} の読み取り失敗: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  // SAFEGUARD 2: 取得メール0件 → 異常事態として中断
  if (emails.size === 0) {
    throw new Error(
      `ABORT: ${tenantsProcessed}テナントから登録メールが0件取得されました。` +
        `読み取り権限またはデータ構造を確認してください。`
    );
  }

  return emails;
}

// ---------- 走査 ----------
async function main() {
  console.log("=== 孤児Firebase Authユーザー掃除 ===");
  console.log(`モード: ${EXECUTE ? "EXECUTE（実削除）" : "DRY-RUN（レポートのみ）"}`);
  console.log(`最小経過時間: ${MIN_AGE_SEC}秒`);
  console.log(`disabled扱い: ${INCLUDE_DISABLED ? "含める" : "スキップ"}`);
  console.log(`連続失敗中断閾値: ${FAIL_ABORT_STREAK}件\n`);

  console.log("テナント内 allowed_emails + users を集約中...");
  const registeredEmails = await collectAllowedAndRegisteredEmails();
  console.log(`登録済みメール数: ${registeredEmails.size}\n`);

  console.log("Firebase Auth ユーザー一覧を走査中...");
  const orphans: Array<{
    uid: string;
    email: string;
    createdMs: number;
    providers: string[];
    disabled: boolean;
  }> = [];
  let totalUsers = 0;
  let skippedNoEmail = 0;
  let skippedDisabled = 0;
  let skippedTooYoung = 0;
  let skippedInvalidCreationTime = 0;
  let nextPageToken: string | undefined;

  do {
    const listResult = await auth.listUsers(1000, nextPageToken);
    nextPageToken = listResult.pageToken;
    for (const user of listResult.users) {
      totalUsers++;

      const email = normalizeEmail(user.email);
      if (!email) {
        skippedNoEmail++;
        continue;
      }

      if (user.disabled && !INCLUDE_DISABLED) {
        skippedDisabled++;
        continue;
      }

      // SAFEGUARD 3: creationTime の NaN チェック（min-age バイパス防止）
      const createdMs = new Date(user.metadata.creationTime).getTime();
      if (!Number.isFinite(createdMs)) {
        console.warn(
          `  警告: ${user.uid} の creationTime が不正: ${user.metadata.creationTime}`
        );
        skippedInvalidCreationTime++;
        continue;
      }

      const ageSec = (Date.now() - createdMs) / 1000;
      if (ageSec < MIN_AGE_SEC) {
        skippedTooYoung++;
        continue;
      }

      if (!registeredEmails.has(email)) {
        orphans.push({
          uid: user.uid,
          email,
          createdMs,
          providers: user.providerData.map((p) => p.providerId),
          disabled: user.disabled,
        });
      }
    }
  } while (nextPageToken);

  console.log(`Firebase Auth ユーザー総数: ${totalUsers}`);
  console.log(`  スキップ(emailなし): ${skippedNoEmail}`);
  console.log(`  スキップ(disabled): ${skippedDisabled}`);
  console.log(`  スキップ(経過時間不足): ${skippedTooYoung}`);
  console.log(`  スキップ(creationTime不正): ${skippedInvalidCreationTime}`);
  console.log(`  孤児候補: ${orphans.length}\n`);

  if (orphans.length === 0) {
    console.log("掃除対象なし。終了。");
    return;
  }

  console.log("=== 孤児ユーザー一覧 ===");
  for (const o of orphans) {
    const created = new Date(o.createdMs).toISOString();
    console.log(
      `  ${o.uid} | ${o.email} | providers=${o.providers.join(",")} | 作成: ${created}`
    );
  }

  if (!EXECUTE) {
    console.log(
      "\n※ dry-run モードのため削除は実行しません。--execute で実削除します。"
    );
    return;
  }

  // バックアップJSON出力（復旧用）
  const backupPath = `orphan-cleanup-backup-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify(orphans, null, 2));
  console.log(`\nバックアップ保存: ${backupPath}`);

  console.log("削除を実行します...");
  let deleted = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const failedUids: string[] = [];

  for (const o of orphans) {
    try {
      await auth.deleteUser(o.uid);
      console.log(`  削除成功: ${o.uid} (${o.email})`);
      deleted++;
      consecutiveFailures = 0;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // エラー種別分岐
      if (code === "auth/user-not-found") {
        console.log(`  スキップ（既削除）: ${o.uid}`);
        continue;
      }
      if (
        code === "auth/insufficient-permission" ||
        code === "auth/quota-exceeded"
      ) {
        console.error(`  致命的エラー、中断: ${code}`, err);
        throw err;
      }
      consecutiveFailures++;
      failed++;
      failedUids.push(o.uid);
      console.error(
        `  削除失敗[${code ?? "unknown"}]: ${o.uid} (${o.email})`,
        err
      );
      if (consecutiveFailures >= FAIL_ABORT_STREAK) {
        throw new Error(
          `${FAIL_ABORT_STREAK}件連続失敗のため中断（バックアップ: ${backupPath}）`
        );
      }
    }
  }

  console.log(`\n完了: 成功=${deleted}, 失敗=${failed}`);
  if (failedUids.length > 0) {
    console.log(`\n=== 削除失敗UID一覧（再試行用）===`);
    failedUids.forEach((uid) => console.log(`  ${uid}`));
  }
}

main().catch((err) => {
  console.error("[FATAL] 孤児Authユーザー掃除が失敗しました");
  console.error(
    `  message: ${err instanceof Error ? err.message : String(err)}`
  );
  if (err instanceof Error && err.stack) {
    console.error(`  stack: ${err.stack}`);
  }
  process.exit(1);
});
