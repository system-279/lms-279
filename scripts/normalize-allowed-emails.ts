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

export type AllowedEmailDoc = { id: string; email: string };

export type NormalizationPlan = {
  updates: { id: string; before: string; after: string }[];
  skips: { id: string; before: string; after: string }[];
};

/**
 * Firestore アクセスから切り離した純粋な計画ロジック（テスト容易性のため切り出し）。
 *
 * 既に正規化済みの email は normalized 集合に初期登録しておき、
 * 大文字混入データを正規化した結果が既存キーと衝突したら skip 扱いにする。
 */
export function planNormalization(docs: AllowedEmailDoc[]): NormalizationPlan {
  const normalizedSet = new Set<string>();
  for (const doc of docs) {
    const raw = doc.email ?? "";
    const n = raw.trim().toLowerCase();
    if (raw === n && n.length > 0) normalizedSet.add(n);
  }

  const updates: NormalizationPlan["updates"] = [];
  const skips: NormalizationPlan["skips"] = [];
  for (const doc of docs) {
    const raw = doc.email ?? "";
    if (!raw) continue;
    const n = raw.trim().toLowerCase();
    if (raw === n) continue;

    if (normalizedSet.has(n)) {
      skips.push({ id: doc.id, before: raw, after: n });
    } else {
      updates.push({ id: doc.id, before: raw, after: n });
      normalizedSet.add(n);
    }
  }
  return { updates, skips };
}

async function main(execute: boolean) {
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
  console.log(`=== normalize-allowed-emails (${execute ? "EXECUTE" : "DRY-RUN"}) ===\n`);

  const tenantsSnap = await db.collection("tenants").get();
  let totalUpdates = 0;
  let totalSkips = 0;

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;
    const allowedSnap = await db.collection(`tenants/${tenantId}/allowed_emails`).get();

    const docs: AllowedEmailDoc[] = allowedSnap.docs.map((d) => ({
      id: d.id,
      email: (d.data().email as string | undefined) ?? "",
    }));
    const plan = planNormalization(docs);

    for (const u of plan.updates) {
      console.log(`[UPDATE] tenant=${tenantId} doc=${u.id}: "${u.before}" -> "${u.after}"`);
      if (execute) {
        await allowedSnap.docs.find((d) => d.id === u.id)!.ref.update({ email: u.after });
      }
    }
    for (const s of plan.skips) {
      console.log(`[SKIP DUPLICATE] tenant=${tenantId} doc=${s.id}: "${s.before}" -> "${s.after}"`);
    }
    totalUpdates += plan.updates.length;
    totalSkips += plan.skips.length;
  }

  console.log(`\nscanned tenants: ${tenantsSnap.size}`);
  console.log(`updates: ${totalUpdates}, skips: ${totalSkips}`);
  if (!execute && totalUpdates > 0) {
    console.log("\n(dry-run): re-run with --execute to apply changes");
  }
}

// import 時のみロジックを export、CLI 実行時のみ main() を呼ぶ
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("normalize-allowed-emails.ts");

if (isMain) {
  const execute = process.argv.includes("--execute");
  main(execute).catch((err) => {
    console.error("normalize-allowed-emails failed:", err);
    process.exit(1);
  });
}
