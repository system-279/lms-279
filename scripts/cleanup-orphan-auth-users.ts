#!/usr/bin/env npx tsx
/**
 * 孤児Firebase Authユーザー掃除スクリプト（Phase 1.7 / ADR-031）
 *
 * OAuth同意画面のExternal化（ADR-031のPhase 1）により、全世界のGoogleユーザーが
 * Firebase Authにユーザーレコードを作成できる状態となる。アプリ側ではallowed_emailsで
 * 認可制御しているため実害はないが、長期的にはFirebase Authに未所属ユーザーが蓄積する。
 *
 * 本スクリプトは以下を実行する:
 * 1. Firebase Authの全ユーザーを取得
 * 2. 全テナントのusers + allowed_emails を集約
 * 3. どのテナントにも所属していない（email非一致）ユーザーを孤児と判定
 * 4. デフォルトはdry-run（レポート出力のみ）、--execute で実際に削除
 *
 * 運用: 週次 or 月次でCloud Schedulerから実行想定（Phase 5で正式化）
 *
 * 使用方法:
 *   # dry-run (デフォルト)
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/cleanup-orphan-auth-users.ts
 *
 *   # 実削除
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/cleanup-orphan-auth-users.ts --execute
 *
 *   # 作成から一定時間経過したユーザーのみ対象（秒単位、デフォルト3600=1時間）
 *   npx tsx scripts/cleanup-orphan-auth-users.ts --min-age-seconds=86400
 */

import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// ---------- 引数パース ----------
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const MIN_AGE_SEC = Number(
  args.find((a) => a.startsWith("--min-age-seconds="))?.split("=")[1] ?? "3600"
);

// ---------- Firebase初期化 ----------
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credPath) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const serviceAccount = require(credPath) as ServiceAccount;
  initializeApp({ credential: cert(serviceAccount) });
} else {
  initializeApp();
}

const db = getFirestore();
const auth = getAuth();

// ---------- 正規化 ----------
const normalizeEmail = (email: string | undefined): string =>
  (email ?? "").trim().toLowerCase();

// ---------- 集約 ----------
async function collectAllowedAndRegisteredEmails(): Promise<Set<string>> {
  const emails = new Set<string>();
  const tenantsSnap = await db.collection("tenants").get();
  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;

    const allowedSnap = await db
      .collection(`tenants/${tenantId}/allowed_emails`)
      .get();
    for (const doc of allowedSnap.docs) {
      const email = normalizeEmail(doc.data().email);
      if (email) emails.add(email);
    }

    const usersSnap = await db.collection(`tenants/${tenantId}/users`).get();
    for (const doc of usersSnap.docs) {
      const email = normalizeEmail(doc.data().email);
      if (email) emails.add(email);
    }
  }
  return emails;
}

// ---------- 走査 ----------
async function main() {
  console.log("=== 孤児Firebase Authユーザー掃除 ===");
  console.log(`モード: ${EXECUTE ? "EXECUTE（実削除）" : "DRY-RUN（レポートのみ）"}`);
  console.log(`最小経過時間: ${MIN_AGE_SEC}秒\n`);

  console.log("テナント内 allowed_emails + users を集約中...");
  const registeredEmails = await collectAllowedAndRegisteredEmails();
  console.log(`登録済みメール数: ${registeredEmails.size}\n`);

  console.log("Firebase Auth ユーザー一覧を走査中...");
  const orphans: Array<{ uid: string; email: string; createdMs: number }> = [];
  let totalUsers = 0;
  let nextPageToken: string | undefined;

  do {
    const listResult = await auth.listUsers(1000, nextPageToken);
    nextPageToken = listResult.pageToken;
    for (const user of listResult.users) {
      totalUsers++;
      const email = normalizeEmail(user.email);
      if (!email) continue;
      const createdMs = new Date(user.metadata.creationTime).getTime();
      const ageSec = (Date.now() - createdMs) / 1000;
      if (ageSec < MIN_AGE_SEC) continue;
      if (!registeredEmails.has(email)) {
        orphans.push({ uid: user.uid, email, createdMs });
      }
    }
  } while (nextPageToken);

  console.log(`Firebase Auth ユーザー総数: ${totalUsers}`);
  console.log(`孤児候補: ${orphans.length}\n`);

  if (orphans.length === 0) {
    console.log("掃除対象なし。終了。");
    return;
  }

  console.log("=== 孤児ユーザー一覧 ===");
  for (const o of orphans) {
    const created = new Date(o.createdMs).toISOString();
    console.log(`  ${o.uid} | ${o.email} | 作成: ${created}`);
  }

  if (!EXECUTE) {
    console.log("\n※ dry-run モードのため削除は実行しません。--execute で実削除します。");
    return;
  }

  console.log("\n削除を実行します...");
  let deleted = 0;
  let failed = 0;
  for (const o of orphans) {
    try {
      await auth.deleteUser(o.uid);
      console.log(`  削除成功: ${o.uid} (${o.email})`);
      deleted++;
    } catch (err) {
      console.error(`  削除失敗: ${o.uid} (${o.email})`, err);
      failed++;
    }
  }
  console.log(`\n完了: 成功=${deleted}, 失敗=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
