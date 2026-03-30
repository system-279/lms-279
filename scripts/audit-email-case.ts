#!/usr/bin/env npx tsx
/**
 * メールアドレス大文字小文字監査スクリプト
 *
 * 全テナントのusersコレクションとallowed_emailsコレクションをスキャンし、
 * 大文字を含むメールアドレスを検出する。
 *
 * 使用方法:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/audit-email-case.ts
 *   または:
 *   npx tsx scripts/audit-email-case.ts  (環境変数が既に設定済みの場合)
 */

import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Firebase初期化
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credPath) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const serviceAccount = require(credPath) as ServiceAccount;
  initializeApp({ credential: cert(serviceAccount) });
} else {
  // Application Default Credentials (Cloud Run等)
  initializeApp();
}

const db = getFirestore();

interface Finding {
  tenantId: string;
  collection: string;
  docId: string;
  email: string;
  lowered: string;
}

async function audit() {
  console.log("=== メールアドレス大文字小文字監査 ===\n");

  const tenantsSnap = await db.collection("tenants").get();
  console.log(`テナント数: ${tenantsSnap.size}\n`);

  const findings: Finding[] = [];

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;

    // users コレクション
    const usersSnap = await db.collection(`tenants/${tenantId}/users`).get();
    for (const userDoc of usersSnap.docs) {
      const email = userDoc.data().email as string | undefined;
      if (email && email !== email.toLowerCase()) {
        findings.push({
          tenantId,
          collection: "users",
          docId: userDoc.id,
          email,
          lowered: email.toLowerCase(),
        });
      }
    }

    // allowed_emails コレクション
    const allowedSnap = await db.collection(`tenants/${tenantId}/allowed_emails`).get();
    for (const doc of allowedSnap.docs) {
      const email = doc.data().email as string | undefined;
      if (email && email !== email.toLowerCase()) {
        findings.push({
          tenantId,
          collection: "allowed_emails",
          docId: doc.id,
          email,
          lowered: email.toLowerCase(),
        });
      }
    }
  }

  // 結果出力
  if (findings.length === 0) {
    console.log("✅ 大文字を含むメールアドレスは見つかりませんでした。\n");
    console.log("マイグレーション不要です。");
  } else {
    console.log(`⚠️  ${findings.length}件の大文字メールを検出:\n`);
    console.log("テナント\tコレクション\tドキュメントID\tメール\t正規化後");
    for (const f of findings) {
      console.log(`${f.tenantId}\t${f.collection}\t${f.docId}\t${f.email}\t${f.lowered}`);
    }
    console.log(`\n修正が必要です。--fix オプションで自動修正を実行できます。`);
  }

  // --fix オプション
  if (process.argv.includes("--fix") && findings.length > 0) {
    console.log(`\n--- 修正実行中 (${findings.length}件) ---\n`);
    for (const f of findings) {
      const ref = db.collection(`tenants/${f.tenantId}/${f.collection}`).doc(f.docId);
      await ref.update({ email: f.lowered });
      console.log(`  ✓ ${f.collection}/${f.docId}: ${f.email} → ${f.lowered}`);
    }
    console.log(`\n✅ ${findings.length}件を修正しました。`);
  }
}

audit().catch((err) => {
  console.error("監査に失敗:", err);
  process.exit(1);
});
