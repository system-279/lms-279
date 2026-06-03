#!/usr/bin/env npx tsx
/**
 * 進捗レポート定期自動配信 dry-run admin SDK CLI (ADR-039)。
 *
 * 目的:
 *   cutover 前に「次の cron 実行で何件送られるか」「テナント別の対象人数 / CC 数」
 *   「推定処理時間 / 推定 PDF サイズ範囲」を read-only で確認する。
 *
 *   完全 read-only:
 *     - Gmail 送信なし
 *     - PDF 実生成なし (cutover smoke `progress-report-smoke.yml` で計測)
 *     - Firestore write なし (settings / dispatch_runs / progress_report_sends いずれも write しない)
 *     - 既存 `services/api/src/services/dispatch/{firestore-tenant-data-loader,firestore-dispatch-storage}`
 *       を直接利用するため本番ロジックと query 構造が完全一致 (重複再実装によるドリフトを回避)。
 *
 * 動作:
 *   1. super_dispatch_settings/global 読み取り (default にフォールバック)
 *   2. tenants 一覧取得 → 各 tenant について active + progressReportEnabled チェック
 *   3. listProgressReportTargetUsers (Plan A: student + 期限内 + 進捗 1% 以上)
 *   4. email validation + CC dedup (本番 run-progress-reports.ts と同じロジック)
 *   5. 100% 完了者は記録上「除外候補」として別カウンタへ (実送信時は完了通知レーンが
 *      カバー済、AC-PR-02)
 *   6. 集計を JSON で stdout + `progress-report-dry-run-result-<ts>.json` に出力
 *
 * 出力に含まれないもの (cutover smoke で別途確認):
 *   - 実 PDF サイズ (テナント / 受講者ごとに変動、5MB 超 skip は本番ロジックでカバー)
 *   - 実 MIME バイトサイズ (PDF 添付込み)
 *   - 実 Gmail rate limit 影響 (per-second sliding window)
 *
 * 使用方法:
 *   # ローカル (ADC 経由)
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *   GOOGLE_CLOUD_PROJECT=lms-279 \
 *   npx tsx scripts/progress-report-dry-run-cli.ts
 *
 *   # workflow_dispatch (WIF 認証)
 *   GitHub Actions UI > Progress Report Dry Run > Run workflow
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-01-progress-report-dispatch-impl-plan.md §PR 3e
 *   - runbook: docs/runbook/dxcollege-progress-report-cutover.md
 *   - 既存 mirror: scripts/dispatch-dry-run-cli.ts (完了通知レーン dry-run)
 */

import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  applicationDefault,
  cert,
  initializeApp,
  type ServiceAccount,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { FirestoreDispatchStorage } from "../services/api/src/services/dispatch/firestore-dispatch-storage.js";
import { FirestoreTenantDataLoader } from "../services/api/src/services/dispatch/firestore-tenant-data-loader.js";
import { evaluateCompletionEligibility } from "../services/api/src/services/dispatch/completion-eligibility.js";
import {
  validateAndDedupeCcEmails,
  validateSingleEmail,
} from "../services/api/src/services/dispatch/cc-email-validator.js";
import { sanitizeErrorForAudit } from "../services/api/src/services/dispatch/dispatch-error-sanitizer.js";
import type { DispatchSettings } from "@lms-279/shared-types";

// ============================================================
// 型定義 (CLI 出力 JSON shape)
// ============================================================

/**
 * tenant 単位で skip された場合の理由。`skipped === true` のときのみ意味を持つ。
 *
 * `tenant_doc_not_found` は listAllTenantIds() が tenantId を返したが tenants/{tid}
 * doc が存在しない異常状態 (subcollection 孤児等)。stderr に WARN を出して運用者の
 * 注意を喚起する。他の skip 理由は通常運用範囲内。
 */
export type DryRunSkipReason =
  | "tenant_doc_not_found"
  | "tenant_not_active"
  | "progress_report_disabled"
  | "no_published_courses";

export interface DryRunTenantSummary {
  tenantId: string;
  skipped: boolean;
  /** `skipped === true` のときのみ設定される */
  skipReason?: DryRunSkipReason;
  usersScanned: number;
  /** listProgressReportTargetUsers の戻り値そのまま (進捗 1% 以上 + 期限内 + student) */
  candidateCount: number;
  /** email が cc-email-validator で reject された user 数 (送信不能) */
  invalidEmailCount: number;
  /** 100% 完了者 (進捗レーンは skip 対象、AC-PR-02。完了通知レーンがカバー済) */
  completedCount: number;
  /** 実送信対象数 = candidateCount - invalidEmailCount - completedCount */
  wouldSendCount: number;
  /** dedup 後の CC 件数 (ownerEmail + notificationCcEmails) */
  ccCount: number;
}

export interface DryRunResultCli {
  evaluatedAt: string;
  settingsLoaded: boolean;
  settingsSnapshot: {
    progressReportEnabled: boolean;
    scheduleDaysOfWeek: number[];
    scheduleHourJst: number;
    signatureName: string;
  } | null;
  tenantsScanned: number;
  tenantsSummary: DryRunTenantSummary[];
  /** 全テナント合算の実送信対象数 */
  totalWouldSendCount: number;
  /** 全テナント合算の CC 件数 (To 1 件あたり付与される CC の延べ数) */
  totalCcCount: number;
  /**
   * 推定処理時間 (ミリ秒)。user 並列度 8 + PDF 生成 / Gmail 送信あたり ~2 秒の経験値で
   * 雑算した参考値。実測は cutover smoke で確認すること。
   */
  estimatedDurationMs: number;
  /**
   * 推定 PDF サイズ範囲 (KB)。過去の手動レポート (PR 3a 以前の progress-pdf-draft) の
   * 経験値レンジ。実測は cutover smoke で確認すること。
   */
  estimatedPdfSizeKbRange: { min: number; typical: number; max: number };
  /** scale trigger: 全テナント合計 300 名超は Cloud Tasks 移行検討 */
  scaleTriggerExceeded: boolean;
}

// ============================================================
// 環境変数 / 定数
// ============================================================

const GCP_PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "lms-279";
const SENDER_EMAIL = process.env.DXCOLLEGE_SENDER_EMAIL ?? "dxcollege@279279.net";

/** 1 通あたりの平均処理時間目安 (PDF 生成 1.5s + Gmail send 0.3s + Firestore write 0.2s) */
const AVG_PER_USER_MS = 2000;
/** user 並列度 (run-progress-reports DEFAULT_USER_CONCURRENCY と一致) */
const USER_CONCURRENCY = 8;
/** scale trigger threshold */
const SCALE_TRIGGER_THRESHOLD = 300;
/** 推定 PDF サイズ範囲 (KB)。実測は cutover smoke で確認 */
const PDF_SIZE_KB_RANGE = { min: 150, typical: 350, max: 1200 };

// ============================================================
// Firebase Admin SDK 初期化 (dispatch-dry-run-cli と同パターン)
// ============================================================

function initFirestore(): Firestore {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    const jsonPath = resolve(process.cwd(), credPath);
    const credJson = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
      type?: string;
    };
    if (credJson.type === "service_account") {
      initializeApp({ credential: cert(credJson as ServiceAccount) });
      console.error(`[init] 認証: サービスアカウント JSON (${jsonPath})`);
    } else {
      initializeApp({ credential: applicationDefault() });
      console.error(
        `[init] 認証: ADC (cred file type=${credJson.type ?? "unknown"}, WIF 想定)`,
      );
    }
  } else {
    initializeApp({ credential: applicationDefault() });
    console.error("[init] 認証: Application Default Credentials");
  }
  return getFirestore();
}

// ============================================================
// メイン dry-run ロジック
// ============================================================

export async function runProgressReportDryRunCli(
  db: Firestore,
  now: Date = new Date(),
): Promise<DryRunResultCli> {
  const storage = new FirestoreDispatchStorage(db);
  const loader = new FirestoreTenantDataLoader(db);

  // ① settings 読み取り
  // doc missing 許容: 初期化前 cutover リハーサル想定で「対象規模見積もり」だけは返す。
  // read/parse error は致命扱いし fail-fast にする (silent fallback は cutover 判断材料の
  // 整合性を壊すため、dispatch-dry-run-cli と同パターン)。
  const settings: DispatchSettings | null = await storage.getDispatchSettings();

  // ② tenants 走査
  const tenantIds = await loader.listAllTenantIds();
  const tenantsSummary: DryRunTenantSummary[] = [];
  let totalWouldSendCount = 0;
  let totalCcCount = 0;

  for (const tenantId of tenantIds) {
    // ③ active + progressReportEnabled チェック (AC-PR-04)
    const tenantInfo = await loader.getTenantInfo(tenantId);
    if (!tenantInfo) {
      // listAllTenantIds() は tenantId を返したが tenants/{tid} doc が不在。
      // subcollection 孤児やテナント cascade delete 未完了の可能性があり、
      // 後で同一 tenantId が再利用されたら誤配信に直結するため stderr で alert。
      console.error(
        `[WARN] tenant_doc_not_found: tenants/${tenantId} doc が存在しません。subcollection 孤児の可能性があるため運用者の確認推奨。`,
      );
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "tenant_doc_not_found",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount: 0,
      });
      continue;
    }
    if (!tenantInfo.active) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "tenant_not_active",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount: 0,
      });
      continue;
    }
    if (!tenantInfo.progressReportEnabled) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "progress_report_disabled",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount: 0,
      });
      continue;
    }

    // ④ CC config 取得 (進捗レーンは CC null でも To 単独で送信、AC-PR-11 設定独立性)
    const ccConfig = await loader.getTenantCcConfig(tenantId);
    const ccDedup = validateAndDedupeCcEmails(
      ccConfig?.notificationCcEmails ?? [],
      ccConfig?.ownerEmail ?? null,
    );
    const ccCount = ccDedup.validCcEmails.length;

    // ⑤ 対象 user 列挙 (Plan A: student + 期限内 + 進捗 1% 以上、ADR-039 D-5)
    const dataView = loader.getTenantDataView(tenantId);
    const publishedCourses = await dataView.listPublishedCourses();
    if (publishedCourses.length === 0) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "no_published_courses",
        usersScanned: 0,
        candidateCount: 0,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 0,
        ccCount,
      });
      continue;
    }

    const users = await dataView.listProgressReportTargetUsers(now);
    // candidateCount は listProgressReportTargetUsers 戻り値全体を表す。
    // 送信不能要因 (invalid email / 100% 完了) は内訳カウンタで切り分け、運用者が
    // 「dry-run で見えない skip 規模」を取りこぼさないようにする。
    const candidateCount = users.length;
    let invalidEmailCount = 0;
    let completedCount = 0;
    let wouldSendCount = 0;

    for (const user of users) {
      // email validation (進捗レーンも完了通知レーンと同様、無効 email は送信不能)
      const emailV = validateSingleEmail(user.email);
      if (!emailV.ok) {
        invalidEmailCount += 1;
        continue;
      }

      // 100% 完了者は進捗レーン skip (AC-PR-02、完了通知レーンがカバー済)
      const progresses = await dataView.listCourseProgressForUser(user.id);
      const eligibility = evaluateCompletionEligibility(
        publishedCourses,
        progresses,
      );
      if (eligibility.eligible) {
        completedCount += 1;
        continue;
      }

      wouldSendCount += 1;
    }

    tenantsSummary.push({
      tenantId,
      skipped: false,
      usersScanned: users.length,
      candidateCount,
      invalidEmailCount,
      completedCount,
      wouldSendCount,
      ccCount,
    });

    totalWouldSendCount += wouldSendCount;
    totalCcCount += wouldSendCount * ccCount;
  }

  // ⑥ 推定処理時間 = (totalWouldSendCount / userConcurrency) * AVG_PER_USER_MS
  // 並列度 8 を超える user 数では Cloud Run timeout (280s) を意識した値になる
  const estimatedDurationMs =
    Math.ceil(totalWouldSendCount / USER_CONCURRENCY) * AVG_PER_USER_MS;

  const result: DryRunResultCli = {
    evaluatedAt: now.toISOString(),
    settingsLoaded: settings !== null,
    settingsSnapshot: settings
      ? {
          progressReportEnabled: settings.progressReport?.enabled ?? false,
          scheduleDaysOfWeek: settings.progressReport?.scheduleDaysOfWeek ?? [],
          scheduleHourJst: settings.progressReport?.scheduleHourJst ?? 0,
          signatureName: settings.signatureName,
        }
      : null,
    tenantsScanned: tenantIds.length,
    tenantsSummary,
    totalWouldSendCount,
    totalCcCount,
    estimatedDurationMs,
    estimatedPdfSizeKbRange: PDF_SIZE_KB_RANGE,
    scaleTriggerExceeded: totalWouldSendCount > SCALE_TRIGGER_THRESHOLD,
  };
  return result;
}

// ============================================================
// CLI エントリポイント
// ============================================================

async function main(): Promise<void> {
  console.error("[progress-report-dry-run-cli] start");
  console.error(`  project: ${GCP_PROJECT_ID}`);
  console.error(`  sender:  ${SENDER_EMAIL}`);
  console.error("");

  const db = initFirestore();
  const result = await runProgressReportDryRunCli(db);

  // stdout に JSON 出力 (workflow log でも見える)
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  // artifact 用のファイル出力 (workflow から upload-artifact で吸い上げる)
  const ts = result.evaluatedAt.replace(/[:.]/g, "-");
  const outFile = `progress-report-dry-run-result-${ts}.json`;
  writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  console.error(`[progress-report-dry-run-cli] result written: ${outFile}`);
  console.error(
    `[progress-report-dry-run-cli] summary: ${result.totalWouldSendCount} target(s), ` +
      `${result.tenantsScanned} tenant(s) scanned, ` +
      `~${Math.round(result.estimatedDurationMs / 1000)}s estimated`,
  );
  const orphanCount = result.tenantsSummary.filter(
    (s) => s.skipReason === "tenant_doc_not_found",
  ).length;
  if (orphanCount > 0) {
    console.error(
      `[progress-report-dry-run-cli] WARN: tenant_doc_not_found が ${orphanCount} 件。` +
        `subcollection 孤児の可能性があるため確認推奨。`,
    );
  }
  if (result.scaleTriggerExceeded) {
    console.error(
      `[progress-report-dry-run-cli] WARN: scale trigger exceeded ` +
        `(>${SCALE_TRIGGER_THRESHOLD} targets) — Cloud Tasks 移行検討`,
    );
  }
}

// テスト import 時に main() が走らないようにエントリポイント判定
const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainEntry) {
  main().catch((err) => {
    process.exitCode = 1;
    process.stderr.write("\n=== progress-report-dry-run-cli FAILED ===\n");
    process.stderr.write(`Error: ${sanitizeErrorForAudit(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(`Stack: ${err.stack}\n`);
    }
  });
}
