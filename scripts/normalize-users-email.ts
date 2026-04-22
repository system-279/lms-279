#!/usr/bin/env npx tsx
/**
 * users.email 既存データ正規化スクリプト（Issue #285 / ADR-031 Phase 3 前提作業）
 *
 * 理由:
 *   `services/api/src/datasource/firestore.ts` の `getUserByEmail` は完全一致検索のため、
 *   Firestore `tenants/{tid}/users` に大文字/前後空白が残るレコードがあると、
 *   正規化済みトークン email (`.trim().toLowerCase()`) ではヒットしない。
 *   その結果、同一人物に対して新規 user レコードが作成され、
 *   user_progress / course_progress / quiz_attempts / video_events が orphan 化する。
 *
 *   PR #277 で allowed_emails は正規化済みだが、users.email は未対応のため本スクリプトで補正する。
 *   GCIP 移行（ADR-031 Phase 3）時は新 UID が発行され email fallback が必須になるため、
 *   事前の正規化が特に重要。
 *
 * 挙動:
 *   - dry-run 既定 (--execute で実際に書き込み)
 *   - 全テナントの tenants/{tid}/users を走査
 *   - email が trim().toLowerCase() と異なるドキュメントを検出
 *   - 正規化後に同一テナント内で重複する場合は skip + 警告（人物同一判定はしない）
 *
 * 使用方法:
 *   npx tsx scripts/normalize-users-email.ts           # dry-run
 *   npx tsx scripts/normalize-users-email.ts --execute # 実行
 */

import { initializeApp, cert, getApps, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export type UserEmailDoc = { id: string; email: string };

export type NormalizationPlan = {
  updates: { id: string; before: string; after: string }[];
  skips: { id: string; before: string; after: string }[];
};

/**
 * Firestore アクセスから切り離した純粋な計画ロジック（テスト容易性のため切り出し）。
 *
 * 既に正規化済みの email は normalized 集合に初期登録しておき、
 * 大文字混入データを正規化した結果が既存キーと衝突したら skip 扱いにする。
 * 重複した場合は人物同一判定をスクリプトで行わず、運用者の手動対応に委ねる。
 */
export function planNormalization(docs: UserEmailDoc[]): NormalizationPlan {
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
  console.log(`=== normalize-users-email (${execute ? "EXECUTE" : "DRY-RUN"}) ===\n`);

  const tenantsSnap = await db.collection("tenants").get();
  let totalUpdates = 0;
  let totalSkips = 0;

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;
    const usersSnap = await db.collection(`tenants/${tenantId}/users`).get();

    const docs: UserEmailDoc[] = usersSnap.docs.map((d) => ({
      id: d.id,
      email: (d.data().email as string | undefined) ?? "",
    }));
    const plan = planNormalization(docs);

    for (const u of plan.updates) {
      console.log(`[UPDATE] tenant=${tenantId} doc=${u.id}: "${u.before}" -> "${u.after}"`);
      if (execute) {
        await usersSnap.docs.find((d) => d.id === u.id)!.ref.update({ email: u.after });
      }
    }
    for (const s of plan.skips) {
      console.log(
        `[SKIP DUPLICATE] tenant=${tenantId} doc=${s.id}: "${s.before}" -> "${s.after}" ` +
          `(正規化後が既存 users.email と衝突。手動で人物同一性を確認してから片方を削除/マージすること)`
      );
    }
    totalUpdates += plan.updates.length;
    totalSkips += plan.skips.length;
  }

  console.log(`\nscanned tenants: ${tenantsSnap.size}`);
  console.log(`updates: ${totalUpdates}, skips: ${totalSkips}`);
  if (totalSkips > 0) {
    console.log(
      "\n⚠️  skips > 0: docs/runbook/normalize-users-email.md の「重複検出時の対応手順」を参照"
    );
  }
  if (!execute && totalUpdates > 0) {
    console.log("\n(dry-run): re-run with --execute to apply changes");
  }
}

// import 時のみロジックを export、CLI 実行時のみ main() を呼ぶ
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("normalize-users-email.ts");

if (isMain) {
  const execute = process.argv.includes("--execute");
  main(execute).catch((err) => {
    console.error("normalize-users-email failed:", err);
    process.exit(1);
  });
}
