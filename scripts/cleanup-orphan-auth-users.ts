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
 *   されない。Phase 3（GCIP 移行本体）完了後に `tenantManager().authForTenant(gcipTenantId)`
 *   対応を追加する（Issue #276 の GCIP Tenant 掃除項目として継続 postponed）。
 *
 * 運用（Issue #276 GCIP 独立部分）:
 *   `.github/workflows/cleanup-orphan-auth-users.yml` が週次で dry-run 自動実行する。
 *   孤児が検出された場合は workflow が job を失敗させ、GitHub 標準のスケジュール失敗
 *   通知で開発者に知らせる（human-in-loop）。実削除は同 workflow を workflow_dispatch +
 *   execute=true で手動起動した場合のみ行う（無人スケジュールでは削除しない）。
 *
 * 結果出力:
 *   実行ごとに `orphan-cleanup-result-<ts>.json`（孤児件数等の機械可読サマリ）を
 *   dry-run / execute 両方で出力する。workflow はこれを読んで通知判定 + step summary に使う。
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
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
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

// テスト import 時の副作用回避: CLI 実行（引数パース・Firebase 初期化・削除）は
// 明示エントリーポイントでのみ分岐する。純粋関数（classifyUser 等）は副作用なく import 可能。
const isMainEntry = import.meta.url === `file://${process.argv[1]}`;

if (isMainEntry) {
  void runCli();
}

// ---------- ユーティリティ ----------
// アプリ側（tenant-auth.ts）は toLowerCase のみだが、掃除時は誤判定防止のため trim も実施
export const normalizeEmail = (email: string | undefined): string =>
  (email ?? "").trim().toLowerCase();

// ---------- 孤児判定（純粋関数: smoke test 対象） ----------
export type UserClassification =
  | "orphan" // 登録なし → 削除候補
  | "registered" // allowed_emails / users に登録あり → 保持
  | "skip-no-email" // email 欠落
  | "skip-disabled" // disabled（include 指定なし）
  | "skip-too-young" // 経過時間が min-age 未満
  | "skip-invalid-creation-time"; // creationTime が parse 不能

export interface ClassifyUserInput {
  email: string | undefined;
  disabled: boolean;
  creationTime: string; // Firebase user.metadata.creationTime
}

export interface ClassifyOptions {
  minAgeSec: number;
  includeDisabled: boolean;
  nowMs: number;
}

/**
 * 1 ユーザーを孤児/保持/各種スキップに分類する。
 * runCleanup() の listUsers ループから抽出した純粋関数（副作用なし）。
 * 判定順序は元実装と同一（email → disabled → creationTime NaN → min-age → 登録有無）。
 */
export function classifyUser(
  user: ClassifyUserInput,
  registeredEmails: Set<string>,
  opts: ClassifyOptions
): UserClassification {
  const email = normalizeEmail(user.email);
  if (!email) return "skip-no-email";
  if (user.disabled && !opts.includeDisabled) return "skip-disabled";
  const createdMs = new Date(user.creationTime).getTime();
  if (!Number.isFinite(createdMs)) return "skip-invalid-creation-time";
  const ageSec = (opts.nowMs - createdMs) / 1000;
  if (ageSec < opts.minAgeSec) return "skip-too-young";
  return registeredEmails.has(email) ? "registered" : "orphan";
}

// ---------- 結果サマリ（機械可読、workflow が読む） ----------
export interface CleanupResult {
  mode: "dry-run" | "execute";
  timestamp: string;
  totalUsers: number;
  registeredEmails: number;
  orphanCount: number;
  skipped: {
    noEmail: number;
    disabled: number;
    tooYoung: number;
    invalidCreationTime: number;
  };
  deleted: number;
  failed: number;
}

// 機械可読サマリを出力（workflow が orphanCount を読んで通知判定 + step summary に使う）
function writeResultJson(result: CleanupResult): void {
  const path = `orphan-cleanup-result-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`\n結果サマリJSON保存: ${path}`);
}

// ---------- 集約 ----------
async function collectAllowedAndRegisteredEmails(
  db: Firestore
): Promise<Set<string>> {
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

// ---------- 削除実行の依存（CLI から注入。テストでは未使用） ----------
interface CleanupDeps {
  auth: Auth;
  db: Firestore;
  execute: boolean;
  includeDisabled: boolean;
  minAgeSec: number;
  failAbortStreak: number;
}

// ---------- 走査 ----------
async function runCleanup(deps: CleanupDeps): Promise<void> {
  const { auth, db, execute, includeDisabled, minAgeSec, failAbortStreak } =
    deps;
  console.log("=== 孤児Firebase Authユーザー掃除 ===");
  console.log(`モード: ${execute ? "EXECUTE（実削除）" : "DRY-RUN（レポートのみ）"}`);
  console.log(`最小経過時間: ${minAgeSec}秒`);
  console.log(`disabled扱い: ${includeDisabled ? "含める" : "スキップ"}`);
  console.log(`連続失敗中断閾値: ${failAbortStreak}件\n`);

  console.log("テナント内 allowed_emails + users を集約中...");
  const registeredEmails = await collectAllowedAndRegisteredEmails(db);
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

  // nowMs は走査開始時点で固定（min-age 判定の基準を全ユーザーで揃える）
  const nowMs = Date.now();

  do {
    const listResult = await auth.listUsers(1000, nextPageToken);
    nextPageToken = listResult.pageToken;
    for (const user of listResult.users) {
      totalUsers++;

      const classification = classifyUser(
        {
          email: user.email,
          disabled: user.disabled,
          creationTime: user.metadata.creationTime,
        },
        registeredEmails,
        { minAgeSec, includeDisabled, nowMs }
      );

      switch (classification) {
        case "skip-no-email":
          skippedNoEmail++;
          break;
        case "skip-disabled":
          skippedDisabled++;
          break;
        case "skip-invalid-creation-time":
          // SAFEGUARD 3: creationTime の NaN チェック（min-age バイパス防止）
          console.warn(
            `  警告: ${user.uid} の creationTime が不正: ${user.metadata.creationTime}`
          );
          skippedInvalidCreationTime++;
          break;
        case "skip-too-young":
          skippedTooYoung++;
          break;
        case "orphan":
          orphans.push({
            uid: user.uid,
            email: normalizeEmail(user.email),
            createdMs: new Date(user.metadata.creationTime).getTime(),
            providers: user.providerData.map((p) => p.providerId),
            disabled: user.disabled,
          });
          break;
        case "registered":
          break; // 登録あり → 保持
      }
    }
  } while (nextPageToken);

  console.log(`Firebase Auth ユーザー総数: ${totalUsers}`);
  console.log(`  スキップ(emailなし): ${skippedNoEmail}`);
  console.log(`  スキップ(disabled): ${skippedDisabled}`);
  console.log(`  スキップ(経過時間不足): ${skippedTooYoung}`);
  console.log(`  スキップ(creationTime不正): ${skippedInvalidCreationTime}`);
  console.log(`  孤児候補: ${orphans.length}\n`);

  const skipped = {
    noEmail: skippedNoEmail,
    disabled: skippedDisabled,
    tooYoung: skippedTooYoung,
    invalidCreationTime: skippedInvalidCreationTime,
  };

  if (orphans.length === 0) {
    console.log("掃除対象なし。終了。");
    writeResultJson({
      mode: execute ? "execute" : "dry-run",
      timestamp: new Date().toISOString(),
      totalUsers,
      registeredEmails: registeredEmails.size,
      orphanCount: 0,
      skipped,
      deleted: 0,
      failed: 0,
    });
    return;
  }

  console.log("=== 孤児ユーザー一覧 ===");
  for (const o of orphans) {
    const created = new Date(o.createdMs).toISOString();
    console.log(
      `  ${o.uid} | ${o.email} | providers=${o.providers.join(",")} | 作成: ${created}`
    );
  }

  if (!execute) {
    console.log(
      "\n※ dry-run モードのため削除は実行しません。--execute で実削除します。"
    );
    writeResultJson({
      mode: "dry-run",
      timestamp: new Date().toISOString(),
      totalUsers,
      registeredEmails: registeredEmails.size,
      orphanCount: orphans.length,
      skipped,
      deleted: 0,
      failed: 0,
    });
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
      if (consecutiveFailures >= failAbortStreak) {
        throw new Error(
          `${failAbortStreak}件連続失敗のため中断（バックアップ: ${backupPath}）`
        );
      }
    }
  }

  console.log(`\n完了: 成功=${deleted}, 失敗=${failed}`);
  if (failedUids.length > 0) {
    console.log(`\n=== 削除失敗UID一覧（再試行用）===`);
    failedUids.forEach((uid) => console.log(`  ${uid}`));
  }

  writeResultJson({
    mode: "execute",
    timestamp: new Date().toISOString(),
    totalUsers,
    registeredEmails: registeredEmails.size,
    orphanCount: orphans.length,
    skipped,
    deleted,
    failed,
  });
}

// ---------- CLI エントリーポイント ----------
async function runCli(): Promise<void> {
  // 引数パース
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

  const execute = args.includes("--execute");
  const includeDisabled = args.includes("--include-disabled");

  const rawMinAge = args
    .find((a) => a.startsWith("--min-age-seconds="))
    ?.split("=")[1];
  const minAgeSec = rawMinAge !== undefined ? Number(rawMinAge) : 3600;
  if (!Number.isFinite(minAgeSec) || minAgeSec < MIN_ALLOWED_MIN_AGE_SEC) {
    console.error(
      `[FATAL] --min-age-seconds は${MIN_ALLOWED_MIN_AGE_SEC}以上の数値が必要です: 受け取った値="${rawMinAge}"`
    );
    process.exit(1);
  }

  const rawFailStreak = args
    .find((a) => a.startsWith("--fail-streak="))
    ?.split("=")[1];
  const failAbortStreak =
    rawFailStreak !== undefined ? Number(rawFailStreak) : 3;
  if (!Number.isFinite(failAbortStreak) || failAbortStreak < 1) {
    console.error(
      `[FATAL] --fail-streak は1以上の数値が必要です: 受け取った値="${rawFailStreak}"`
    );
    process.exit(1);
  }

  // Firebase 初期化
  // GOOGLE_APPLICATION_CREDENTIALS には以下のいずれかが入り得る:
  //   1. type=service_account の JSON（ローカル開発時のサービスアカウントキー）→ cert() で初期化
  //   2. type=external_account の JSON（GitHub Actions WIF 経由）→ applicationDefault() で初期化
  // type を読まずに cert() を使うと WIF JSON で "project_id" property エラーになる
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
        // External Account (WIF) は ADC 経由で初期化する
        initializeApp({ credential: applicationDefault() });
        console.log(
          `認証: Application Default Credentials (cred file type=${
            credJson.type ?? "unknown"
          })`
        );
      }
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

  try {
    await runCleanup({
      auth: getAuth(),
      db: getFirestore(),
      execute,
      includeDisabled,
      minAgeSec,
      failAbortStreak,
    });
  } catch (err) {
    console.error("[FATAL] 孤児Authユーザー掃除が失敗しました");
    console.error(
      `  message: ${err instanceof Error ? err.message : String(err)}`
    );
    if (err instanceof Error && err.stack) {
      console.error(`  stack: ${err.stack}`);
    }
    process.exit(1);
  }
}
