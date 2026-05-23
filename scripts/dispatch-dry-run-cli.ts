#!/usr/bin/env npx tsx
/**
 * DXcollege 自動完了通知 dry-run admin SDK CLI (Phase 8 Step 5 代替)。
 *
 * 目的:
 *   `/super/dispatch-settings` UI の「ドライラン」ボタン (`/api/v2/super/dispatch/dry-run`)
 *   を経由せず、Firestore admin SDK で直接対象一覧 + MIME プレビューを取得する。
 *   既存 UI / API endpoint は撤廃予定 (PR-B) のため、本 CLI が cutover 検証手段。
 *
 *   完全 read-only:
 *     - Gmail 送信なし
 *     - Firestore write なし (settings / dispatch_runs / completion_notifications いずれも write しない)
 *     - 既存 `services/api/src/services/dispatch/{firestore-tenant-data-loader,firestore-dispatch-storage}`
 *       を直接利用するため本番ロジックと query 構造が完全一致 (重複再実装によるドリフトを回避)。
 *
 * 動作:
 *   1. super_dispatch_settings/global 読み取り (default にフォールバック)
 *   2. tenants 一覧取得 → 各 tenant について completionNotificationEnabled チェック
 *   3. published courses + users を走査
 *   4. evaluateCompletionEligibility で 100% 完了判定
 *   5. completion_notifications/{userId} 存在チェック (既送信は除外)
 *   6. 各 user 向け MIME プレビュー (件名/本文/署名/CC) を組み立て
 *   7. 結果を JSON で stdout + `dispatch-dry-run-result-<ts>.json` に出力
 *
 * 使用方法:
 *   # ローカル (ADC 経由)
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *   GOOGLE_CLOUD_PROJECT=lms-279 \
 *   npx tsx scripts/dispatch-dry-run-cli.ts
 *
 *   # workflow_dispatch (WIF 認証)
 *   GitHub Actions UI > Dispatch Dry Run > Run workflow
 *
 * 関連:
 *   - 設計仕様書 §8 (Phase 8 cutover) / AC-8 (dry-run は read-only)
 *   - playbook: docs/runbook/dxcollege-completion-notification-cutover.md Step 5
 *   - 既存 API endpoint (撤廃予定): services/api/src/routes/super/dispatch-dry-run.ts
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
import { validateSingleEmail } from "../services/api/src/services/dispatch/cc-email-validator.js";
import { buildCompletionMail } from "../services/api/src/services/dispatch/completion-notification-mail.js";
import { sanitizeErrorForAudit } from "../services/api/src/services/dispatch/dispatch-error-sanitizer.js";
import type { DispatchSettings } from "@lms-279/shared-types";

// ============================================================
// 型定義 (CLI 出力 JSON shape)
// ============================================================

export interface DryRunMimePreview {
  from: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
}

export interface DryRunTargetCli {
  tenantId: string;
  userId: string;
  userEmail: string;
  userName: string;
  courseIdsSnapshot: string[];
  mimePreview: DryRunMimePreview;
}

export interface DryRunTenantSummary {
  tenantId: string;
  skipped: boolean;
  skipReason?: string;
  usersScanned: number;
  eligibleCount: number;
}

export interface DryRunResultCli {
  evaluatedAt: string;
  settingsLoaded: boolean;
  settingsSnapshot: {
    enabled: boolean;
    scheduleDaysOfWeek: number[];
    scheduleHourJst: number;
    signatureName: string;
    completionMessageBodyLength: number;
  } | null;
  tenantsScanned: number;
  tenantsSummary: DryRunTenantSummary[];
  wouldNotifyCount: number;
  wouldNotify: DryRunTargetCli[];
}

// ============================================================
// 環境変数 / 定数
// ============================================================

const GCP_PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "lms-279";
const SENDER_EMAIL = process.env.DXCOLLEGE_SENDER_EMAIL ?? "dxcollege@279279.net";

// settings 未保存テナント / フォールバック時の default 値 (本番では doc 必須だが、初期化前
// の cutover リハーサルでも対象一覧プレビューを返せるようにする)。
const DEFAULT_SIGNATURE = "DXcollege運営スタッフ";
const DEFAULT_BODY = "(本文未設定 — super_dispatch_settings/global.completionMessageBody を保存してください)";

// ============================================================
// Firebase Admin SDK 初期化
// ============================================================

function initFirestore(): Firestore {
  // 認証経路の分岐 (cleanup-orphan-auth-users.ts と同じパターン):
  //   1. type=service_account の JSON (ローカル SA key) → cert() で初期化
  //   2. type=external_account の JSON (GitHub Actions WIF 経由) → applicationDefault() で ADC 委譲
  //   3. GOOGLE_APPLICATION_CREDENTIALS 未設定 → applicationDefault() (Cloud Run ADC 等)
  // type を読まずに cert() を使うと WIF JSON で project_id property 不在エラーになる。
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

export async function runDryRunCli(db: Firestore): Promise<DryRunResultCli> {
  const storage = new FirestoreDispatchStorage(db);
  const loader = new FirestoreTenantDataLoader(db);

  // ① settings 読み取り (なければ default を使い、preview のみ提供)
  let settings: DispatchSettings | null = null;
  try {
    settings = await storage.getDispatchSettings();
  } catch (err) {
    // settings 読み取り失敗は致命ではない (preview なら default で進行)
    console.error(`WARN: getDispatchSettings failed: ${sanitizeErrorForAudit(err)}`);
  }

  const signature = settings?.signatureName ?? DEFAULT_SIGNATURE;
  const messageBody = settings?.completionMessageBody ?? DEFAULT_BODY;

  // ② tenants 走査
  const tenantIds = await loader.listAllTenantIds();
  const tenantsSummary: DryRunTenantSummary[] = [];
  const wouldNotify: DryRunTargetCli[] = [];

  for (const tenantId of tenantIds) {
    const ccConfig = await loader.getTenantCcConfig(tenantId);

    // テナント単位 disable は対象外 (本番 dispatch-dry-run.ts の logic と整合)
    if (!ccConfig?.completionNotificationEnabled) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "tenant_completion_notification_disabled",
        usersScanned: 0,
        eligibleCount: 0,
      });
      continue;
    }

    const dataView = loader.getTenantDataView(tenantId);
    const publishedCourses = await dataView.listPublishedCourses();
    if (publishedCourses.length === 0) {
      tenantsSummary.push({
        tenantId,
        skipped: true,
        skipReason: "no_published_courses",
        usersScanned: 0,
        eligibleCount: 0,
      });
      continue;
    }

    const users = await dataView.listNotificationTargetUsers();
    let eligibleCount = 0;

    for (const user of users) {
      // email 無効はどのみち送信されない (AC-19)
      const emailV = validateSingleEmail(user.email);
      if (!emailV.ok) continue;

      const progresses = await dataView.listCourseProgressForUser(user.id);
      const eligibility = evaluateCompletionEligibility(publishedCourses, progresses);
      if (!eligibility.eligible) continue;

      // 既存 notification (sent/reserved/failed/manual) は再送されない
      const existing = await storage.getCompletionNotification(tenantId, user.id);
      if (existing) continue;

      // MIME プレビュー組立
      const built = buildCompletionMail({
        userName: user.name,
        completionMessageBody: messageBody,
        signatureName: signature,
      });

      const ccList: string[] = [];
      if (ccConfig.ownerEmail) ccList.push(ccConfig.ownerEmail);
      for (const cc of ccConfig.notificationCcEmails ?? []) {
        if (cc && !ccList.includes(cc)) ccList.push(cc);
      }

      wouldNotify.push({
        tenantId,
        userId: user.id,
        userEmail: emailV.value,
        userName: user.name ?? "",
        courseIdsSnapshot: eligibility.courseIdsSnapshot,
        mimePreview: {
          from: `${signature} <${SENDER_EMAIL}>`,
          to: emailV.value,
          cc: ccList,
          subject: built.subject,
          body: built.body,
        },
      });
      eligibleCount++;
    }

    tenantsSummary.push({
      tenantId,
      skipped: false,
      usersScanned: users.length,
      eligibleCount,
    });
  }

  const result: DryRunResultCli = {
    evaluatedAt: new Date().toISOString(),
    settingsLoaded: settings !== null,
    settingsSnapshot: settings
      ? {
          enabled: settings.enabled,
          scheduleDaysOfWeek: settings.scheduleDaysOfWeek,
          scheduleHourJst: settings.scheduleHourJst,
          signatureName: settings.signatureName,
          completionMessageBodyLength: settings.completionMessageBody.length,
        }
      : null,
    tenantsScanned: tenantIds.length,
    tenantsSummary,
    wouldNotifyCount: wouldNotify.length,
    wouldNotify,
  };
  return result;
}

// ============================================================
// CLI エントリポイント
// ============================================================

async function main(): Promise<void> {
  console.error("[dispatch-dry-run-cli] start");
  console.error(`  project: ${GCP_PROJECT_ID}`);
  console.error(`  sender:  ${SENDER_EMAIL}`);
  console.error("");

  const db = initFirestore();
  const result = await runDryRunCli(db);

  // stdout に JSON 出力 (workflow log でも見える)
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  // artifact 用のファイル出力 (workflow から upload-artifact で吸い上げる)
  const ts = result.evaluatedAt.replace(/[:.]/g, "-");
  const outFile = `dispatch-dry-run-result-${ts}.json`;
  writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  console.error(`[dispatch-dry-run-cli] result written: ${outFile}`);
  console.error(
    `[dispatch-dry-run-cli] summary: ${result.wouldNotifyCount} target(s), ` +
      `${result.tenantsScanned} tenant(s) scanned`,
  );
}

// テスト import 時に main() が走らないようにエントリポイント判定する。
// `pathToFileURL` で URL encode 差 (空白 / 非 ASCII path) を吸収する。
const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainEntry) {
  main().catch((err) => {
    process.exitCode = 1;
    process.stderr.write("\n=== dispatch-dry-run-cli FAILED ===\n");
    process.stderr.write(`Error: ${sanitizeErrorForAudit(err)}\n`);
    if (err instanceof Error && err.stack) {
      // stack は workflow log で開発者にのみ見える (Cloud Build 等で漏洩しない構成前提)
      process.stderr.write(`Stack: ${err.stack}\n`);
    }
  });
}
