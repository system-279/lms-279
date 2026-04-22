#!/usr/bin/env npx tsx
/**
 * users.email 既存データ正規化スクリプト（Issue #285 / ADR-031 Phase 3 前提作業）
 *
 * 理由:
 *   `services/api/src/datasource/firestore.ts#getUserByEmail` は完全一致検索のため、
 *   Firestore `tenants/{tid}/users` に大文字/前後空白が残るレコードがあると、
 *   `middleware/tenant-auth.ts` 側で正規化された email (`.trim().toLowerCase()`)
 *   ではヒットしない。その結果、同一人物に対して新規 user レコードが作成され、
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
 *   - テナント単位で try/catch し、特定テナントの失敗で全体を止めない
 *   - skips > 0 の場合は exit code 2（運用者が確実に気付くため）、
 *     テナント失敗 > 0 の場合は exit code 3
 *
 * 使用方法:
 *   npx tsx scripts/normalize-users-email.ts           # dry-run
 *   npx tsx scripts/normalize-users-email.ts --execute # 実行
 */

import { initializeApp, cert, getApps, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export type UserEmailDoc = { id: string; email: string | undefined };

export type EmailChange = {
  readonly id: string;
  readonly before: string;
  readonly after: string;
};

export type NormalizationPlan = {
  readonly updates: readonly EmailChange[];
  readonly skips: readonly EmailChange[];
};

/**
 * Firestore アクセスから切り離した純粋な計画ロジック（テスト容易性のため切り出し）。
 *
 * 挙動:
 *   - 空 email（空文字 / undefined / null）は normalizedSet への登録と判定の両方で無視される
 *     （空文字同士の衝突による誤検出防止）。
 *   - 既に正規化済みの email は normalizedSet に初期登録しておき、
 *     大文字/空白混入データを正規化した結果が既存キーと衝突したら skip 扱いにする。
 *   - **未正規化データ同士が同じ正規化結果になる場合**、入力配列の順で最初の 1 件が `updates`、
 *     2 件目以降が `skips` になる（Firestore の doc 取得順に依存）。運用者は `[UPDATE]` / `[SKIP DUPLICATE]`
 *     両方をレビューして人物同一性を判断する必要がある。
 *   - 人物同一判定はスクリプトで行わず、運用者の手動対応に委ねる。
 */
export function planNormalization(docs: UserEmailDoc[]): NormalizationPlan {
  const normalizedSet = new Set<string>();
  for (const doc of docs) {
    const raw = doc.email ?? "";
    const n = raw.trim().toLowerCase();
    if (raw === n && n.length > 0) normalizedSet.add(n);
  }

  const updates: EmailChange[] = [];
  const skips: EmailChange[] = [];
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

type TenantFailure = { tenantId: string; error: string };

async function main(execute: boolean): Promise<number> {
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const serviceAccount = require(credPath) as ServiceAccount;
      initializeApp({ credential: cert(serviceAccount) });
      console.log(
        `[auth] SA credentials from GOOGLE_APPLICATION_CREDENTIALS=${credPath} ` +
          `(project=${serviceAccount.projectId ?? "unknown"})`
      );
    } else {
      initializeApp();
      const resolvedProject =
        getApps()[0]?.options?.projectId ??
        process.env.FIREBASE_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        "unknown";
      console.log(`[auth] using Application Default Credentials (ADC) (project=${resolvedProject})`);
    }
  }

  const db = getFirestore();
  console.log(`=== normalize-users-email (${execute ? "EXECUTE" : "DRY-RUN"}) ===\n`);

  const tenantsSnap = await db.collection("tenants").get();
  let totalUpdates = 0;
  let totalSkips = 0;
  const failures: TenantFailure[] = [];

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;
    try {
      const usersSnap = await db.collection(`tenants/${tenantId}/users`).get();
      const refById = new Map(usersSnap.docs.map((d) => [d.id, d.ref] as const));

      const docs: UserEmailDoc[] = usersSnap.docs.map((d) => {
        const raw = d.data().email;
        // Firestore では null / number / 空 object など予期しない型が入ることがある。
        // string 以外は undefined に寄せて planNormalization 内で空扱いにする（.trim() 呼び出しでの crash 防止）。
        return { id: d.id, email: typeof raw === "string" ? raw : undefined };
      });
      const plan = planNormalization(docs);

      for (const u of plan.updates) {
        console.log(`[UPDATE] tenant=${tenantId} doc=${u.id}: "${u.before}" -> "${u.after}"`);
        if (execute) {
          const ref = refById.get(u.id);
          if (!ref) {
            console.error(
              `[ERROR] ref not found tenant=${tenantId} doc=${u.id} ` +
                `(snapshot mismatch; skipping this doc)`
            );
            continue;
          }
          await ref.update({ email: u.after });
        }
      }
      for (const s of plan.skips) {
        console.log(
          `[SKIP DUPLICATE] tenant=${tenantId} doc=${s.id}: "${s.before}" -> "${s.after}" ` +
            `(正規化後が既存 users.email と衝突。docs/runbook/normalize-users-email.md Step 2 参照)`
        );
      }
      totalUpdates += plan.updates.length;
      totalSkips += plan.skips.length;
    } catch (err) {
      console.error(`[ERROR] tenant=${tenantId} failed:`, err);
      failures.push({ tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`\nscanned tenants: ${tenantsSnap.size}`);
  console.log(
    `updates: ${totalUpdates}, skips: ${totalSkips}, failed tenants: ${failures.length}`
  );

  if (failures.length > 0) {
    console.error(`\nFAILED tenants (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f.tenantId}: ${f.error}`);
  }
  if (totalSkips > 0) {
    console.error(
      "\n⚠️  skips > 0: docs/runbook/normalize-users-email.md Step 2 の重複対応手順を参照し、" +
        "手動マージ完了後に再実行してください（exit code 2）"
    );
  }
  if (!execute && totalUpdates > 0) {
    console.log("\n(dry-run): re-run with --execute to apply changes");
  }

  // exit code: 0=OK, 2=skips>0, 3=tenant failure あり（複合時は tenant failure 優先）
  if (failures.length > 0) return 3;
  if (totalSkips > 0) return 2;
  return 0;
}

// import 時のみロジックを export、CLI 実行時のみ main() を呼ぶ
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("normalize-users-email.ts");

if (isMain) {
  const execute = process.argv.includes("--execute");
  main(execute)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("normalize-users-email failed:", err);
      process.exit(1);
    });
}
