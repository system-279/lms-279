#!/usr/bin/env npx tsx
/**
 * allowed_emails 既存データ正規化スクリプト（本PR Phase 1 デプロイ前に実行必須）
 *
 * 理由:
 *   routes/shared/allowed-emails.ts の POST は新規登録時に email を
 *   trim().toLowerCase() で正規化するようになったが、
 *   Firestore 既存ドキュメントに大文字混入データが残っている場合、
 *   FirestoreDataSource.isEmailAllowed (normalized === でのクエリ) と一致せず、
 *   既存ユーザーがログイン不能になる可能性がある。
 *
 * 挙動:
 *   - dry-run 既定 (--execute で実際に書き込み)
 *   - 全テナントの tenants/{tid}/allowed_emails を走査
 *   - email が trim().toLowerCase() と異なるドキュメントを検出
 *   - 正規化後に同一テナント内で重複する場合は skip + 警告
 *
 * 使用方法:
 *   npx tsx scripts/normalize-allowed-emails.ts           # dry-run
 *   npx tsx scripts/normalize-allowed-emails.ts --execute # 実行
 */

import { initializeApp, cert, getApps, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (getApps().length === 0) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const serviceAccount = require(credPath) as ServiceAccount;
    initializeApp({ credential: cert(serviceAccount) });
  } else {
    initializeApp();
  }
}

const db = getFirestore();
const execute = process.argv.includes("--execute");

type Change = {
  tenantId: string;
  docId: string;
  before: string;
  after: string;
  action: "update" | "skip_duplicate";
};

async function main() {
  console.log(`=== normalize-allowed-emails (${execute ? "EXECUTE" : "DRY-RUN"}) ===\n`);

  const tenantsSnap = await db.collection("tenants").get();
  const changes: Change[] = [];

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;
    const allowedSnap = await db.collection(`tenants/${tenantId}/allowed_emails`).get();

    // 既に正規化済みの email 集合（重複検出用）
    const normalizedSet = new Set<string>();
    for (const doc of allowedSnap.docs) {
      const raw = (doc.data().email as string | undefined) ?? "";
      const normalized = raw.trim().toLowerCase();
      if (raw === normalized) normalizedSet.add(normalized);
    }

    for (const doc of allowedSnap.docs) {
      const raw = (doc.data().email as string | undefined) ?? "";
      if (!raw) continue;
      const normalized = raw.trim().toLowerCase();
      if (raw === normalized) continue;

      if (normalizedSet.has(normalized)) {
        changes.push({ tenantId, docId: doc.id, before: raw, after: normalized, action: "skip_duplicate" });
        continue;
      }

      changes.push({ tenantId, docId: doc.id, before: raw, after: normalized, action: "update" });
      normalizedSet.add(normalized);

      if (execute) {
        await doc.ref.update({ email: normalized });
      }
    }
  }

  console.log(`scanned tenants: ${tenantsSnap.size}`);
  console.log(`changes: ${changes.length}\n`);

  for (const c of changes) {
    const tag = c.action === "update" ? "[UPDATE]" : "[SKIP DUPLICATE]";
    console.log(`${tag} tenant=${c.tenantId} doc=${c.docId}: "${c.before}" -> "${c.after}"`);
  }

  if (!execute && changes.length > 0) {
    console.log("\n(dry-run): re-run with --execute to apply changes");
  }
  if (execute) {
    console.log("\ndone.");
  }
}

main().catch((err) => {
  console.error("normalize-allowed-emails failed:", err);
  process.exit(1);
});
