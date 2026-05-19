#!/usr/bin/env npx tsx
/**
 * tenant 配下 auth_error_logs サマリ調査スクリプト（read-only）
 *
 * 目的:
 *   「該当 email では拒否ログが見つからないが、ご本人がログインできないと言っている」
 *   ケースで、tenant 内の直近 auth_error_logs を集計し、別 email での拒否があるかを切り分ける。
 *
 * 安全機構:
 *   - read-only（書き込み一切なし）
 *   - tenant_id は必須入力
 *   - email 別件数は --email-filter-domain 指定時のみ表示（PII 漏洩防止）
 *     domain 未指定時は reason 別集計のみ
 *
 * 使用方法:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *     npx tsx scripts/audit-tenant-auth-errors.ts \
 *     --tenant-id=atali82i \
 *     --since-hours=720 \
 *     --email-filter-domain=fuku-no-tane.com \
 *     --top-emails=20
 *
 * 環境変数:
 *   GOOGLE_APPLICATION_CREDENTIALS  サービスアカウント JSON のパス（WIF 環境では external_account JSON）
 *   GOOGLE_CLOUD_PROJECT            プロジェクト ID
 */

import {
  initializeApp,
  cert,
  applicationDefault,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore, type Firestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { resolve } from "path";

// ============================================================
// 純粋関数（smoke test 対象）
// ============================================================

export interface RawLog {
  email: string | null;
  reason: string | null;
  occurredAt: string;
}

export interface AggregatedSummary {
  totalLogs: number;
  /** reason → 件数（降順） */
  reasonCounts: Array<{ reason: string; count: number }>;
  /** domain でフィルタした後の email → 件数（降順、top N でカット） */
  filteredEmailCounts: Array<{ email: string; count: number }>;
  /** domain フィルタ後にカットされた残り件数 */
  filteredEmailTruncated: number;
  /** domain にマッチした unique email 数（top で切られても全体数として把握） */
  filteredEmailUniqueCount: number;
}

/**
 * 集計（純粋関数）。domain フィルタ未指定時は filteredEmailCounts は空配列。
 *
 * @param logs 取得済みログ
 * @param emailDomainFilter "fuku-no-tane.com" 等の domain（小文字、@ なし）。null なら email 集計しない。
 * @param topEmails domain フィルタ後の上位件数。1 以上。
 */
export function aggregateLogs(
  logs: RawLog[],
  emailDomainFilter: string | null,
  topEmails: number
): AggregatedSummary {
  const reasonMap = new Map<string, number>();
  for (const log of logs) {
    const reason = log.reason ?? "(missing)";
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
  }
  const reasonCounts = Array.from(reasonMap.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  if (!emailDomainFilter) {
    return {
      totalLogs: logs.length,
      reasonCounts,
      filteredEmailCounts: [],
      filteredEmailTruncated: 0,
      filteredEmailUniqueCount: 0,
    };
  }

  const suffix = `@${emailDomainFilter}`;
  const emailMap = new Map<string, number>();
  for (const log of logs) {
    const email = log.email?.trim().toLowerCase();
    if (!email) continue;
    if (!email.endsWith(suffix)) continue;
    emailMap.set(email, (emailMap.get(email) ?? 0) + 1);
  }
  const allEmailEntries = Array.from(emailMap.entries())
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count);
  const filteredEmailCounts = allEmailEntries.slice(0, topEmails);
  const filteredEmailTruncated = Math.max(
    0,
    allEmailEntries.length - filteredEmailCounts.length
  );

  return {
    totalLogs: logs.length,
    reasonCounts,
    filteredEmailCounts,
    filteredEmailTruncated,
    filteredEmailUniqueCount: emailMap.size,
  };
}

// ============================================================
// CLI 引数パース
// ============================================================

const KNOWN_FLAGS = [
  "--tenant-id=",
  "--since-hours=",
  "--email-filter-domain=",
  "--top-emails=",
];

const isMainEntry = import.meta.url === `file://${process.argv[1]}`;

if (isMainEntry) {
  void runCli();
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter(
    (a) => !KNOWN_FLAGS.some((k) => a.startsWith(k))
  );
  if (unknownArgs.length > 0) {
    console.error(`[FATAL] 未知のフラグ: ${unknownArgs.join(", ")}`);
    console.error(`  既知のフラグ: ${KNOWN_FLAGS.join(" / ")}`);
    process.exit(1);
  }

  const tenantId = args
    .find((a) => a.startsWith("--tenant-id="))
    ?.split("=")[1];
  const sinceHoursRaw = args
    .find((a) => a.startsWith("--since-hours="))
    ?.split("=")[1];
  const emailDomainRaw = args
    .find((a) => a.startsWith("--email-filter-domain="))
    ?.split("=")[1];
  const topEmailsRaw = args
    .find((a) => a.startsWith("--top-emails="))
    ?.split("=")[1];

  if (!tenantId) {
    console.error("[FATAL] --tenant-id は必須です");
    process.exit(1);
  }

  const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : 72;
  if (!Number.isFinite(sinceHours) || sinceHours <= 0 || sinceHours > 24 * 30) {
    console.error(
      `[FATAL] --since-hours は 1〜720 の数値: 受け取った値="${sinceHoursRaw}"`
    );
    process.exit(1);
  }

  const topEmails = topEmailsRaw ? Number(topEmailsRaw) : 20;
  if (!Number.isFinite(topEmails) || topEmails <= 0 || topEmails > 200) {
    console.error(
      `[FATAL] --top-emails は 1〜200 の数値: 受け取った値="${topEmailsRaw}"`
    );
    process.exit(1);
  }

  const emailDomainFilter = emailDomainRaw
    ? emailDomainRaw.trim().toLowerCase().replace(/^@/, "")
    : null;
  if (emailDomainFilter !== null && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(emailDomainFilter)) {
    console.error(
      `[FATAL] --email-filter-domain の形式が不正: "${emailDomainRaw}"`
    );
    process.exit(1);
  }

  // Firebase 初期化（cleanup-stuck-quiz-attempts.ts と同じ WIF / SA JSON 兼用ロジック）
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
        initializeApp({ credential: applicationDefault() });
        console.log(
          `認証: Application Default Credentials (cred file type=${credJson.type ?? "unknown"})`
        );
      }
    } else {
      initializeApp({ credential: applicationDefault() });
      console.log("認証: Application Default Credentials");
    }
  } catch (err) {
    console.error(
      `[FATAL] Firebase 初期化失敗: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  const db = getFirestore();

  console.log("=== tenant 配下 auth_error_logs サマリ調査 ===");
  console.log(`tenant: ${tenantId}`);
  console.log(`参照範囲: 直近 ${sinceHours} 時間`);
  console.log(
    `email domain フィルタ: ${emailDomainFilter ?? "(未指定。email 別集計は表示しません)"}`
  );
  if (emailDomainFilter) {
    console.log(`email 別表示上位件数: ${topEmails}`);
  }
  console.log();

  const tenantRef = db.collection("tenants").doc(tenantId);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) {
    console.error(`[FATAL] tenant not found: ${tenantId}`);
    process.exit(1);
  }
  console.log(`tenant 確認: ${tenantId} (name="${tenantDoc.data()?.name ?? ""}")\n`);

  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const logs = await fetchAllLogsSince(db, tenantId, since);
  console.log(`取得件数: ${logs.length}\n`);

  const summary = aggregateLogs(logs, emailDomainFilter, topEmails);
  printSummary(summary, emailDomainFilter);
}

// ============================================================
// Firestore 取得（read-only）
// ============================================================

async function fetchAllLogsSince(
  db: Firestore,
  tenantId: string,
  since: Date
): Promise<RawLog[]> {
  const snap = await db
    .collection(`tenants/${tenantId}/auth_error_logs`)
    .where("occurredAt", ">=", Timestamp.fromDate(since))
    .orderBy("occurredAt", "desc")
    .limit(2000)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    const ts = data.occurredAt;
    const occurredAt =
      ts instanceof Timestamp
        ? ts.toDate().toISOString()
        : typeof ts === "string"
          ? ts
          : new Date(0).toISOString();
    return {
      email: (data.email as string | undefined) ?? null,
      reason: (data.reason as string | undefined) ?? null,
      occurredAt,
    };
  });
}

// ============================================================
// 出力
// ============================================================

function printSummary(
  summary: AggregatedSummary,
  emailDomainFilter: string | null
): void {
  console.log("=== reason 別件数 ===");
  if (summary.reasonCounts.length === 0) {
    console.log("  (該当ログなし)");
  } else {
    for (const { reason, count } of summary.reasonCounts) {
      console.log(`  ${count.toString().padStart(5)}  ${reason}`);
    }
  }
  console.log();

  if (!emailDomainFilter) {
    console.log(
      "email 別集計: --email-filter-domain 未指定のため表示しません (PII 制限)"
    );
    return;
  }

  console.log(
    `=== email 別件数 (domain=${emailDomainFilter}, unique=${summary.filteredEmailUniqueCount}) ===`
  );
  if (summary.filteredEmailCounts.length === 0) {
    console.log(`  (該当 domain での拒否ログなし)`);
  } else {
    for (const { email, count } of summary.filteredEmailCounts) {
      console.log(`  ${count.toString().padStart(5)}  ${email}`);
    }
    if (summary.filteredEmailTruncated > 0) {
      console.log(`  ...他 ${summary.filteredEmailTruncated} email 省略`);
    }
  }
}
