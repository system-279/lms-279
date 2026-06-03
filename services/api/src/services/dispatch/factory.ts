/**
 * Dispatch 機能の production wiring factory。
 *
 * Phase 7 wiring: 環境変数に応じて Firestore / InMemory 実装を切り替える。
 *
 * 設計仕様書 §3 / impl-plan §3 Phase 7。
 *
 * 切り替え戦略:
 *   - `DISPATCH_USE_IN_MEMORY=true` → InMemory 実装 (test / dev、Firestore 不要)
 *   - それ以外 (本番 / Cloud Run) → Firestore 実装
 *
 * 必須 env (本番):
 *   - `DXCOLLEGE_SENDER_EMAIL`: MIME From ヘッダ用の SendAs alias (例 dxcollege@279279.net)
 *   - `DXCOLLEGE_DISPATCH_SUBJECT`: DWD JWT subject = 実 mailbox (例 system@279279.net)
 *   - `DISPATCH_OIDC_AUDIENCE`: Cloud Run 自身の URL (Cloud Scheduler OIDC token の audience)
 *
 * 任意 env:
 *   - `DISPATCH_USE_IN_MEMORY`: "true" で InMemory に強制切替 (test / 緊急時)
 *
 * 関連 ADR: ADR-028 (テスト戦略), ADR-037 (sender impersonation)
 */

import { getFirestore } from "firebase-admin/firestore";
import { renderToBuffer } from "@react-pdf/renderer";
import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";

import { FirestoreDispatchStorage } from "./firestore-dispatch-storage.js";
import { FirestoreTenantDataLoader } from "./firestore-tenant-data-loader.js";
import { InMemoryDispatchStorage } from "./in-memory-dispatch-storage.js";
import { InMemoryTenantDataLoader } from "./tenant-data-loader.js";
import {
  GoogleOidcTokenVerifier,
  type OidcTokenVerifier,
} from "./oidc-verify.js";
import type { DispatchStorage } from "./dispatch-storage.js";
import type { TenantDataLoader } from "./tenant-data-loader.js";
import type { DispatchEnv } from "./run-completion-notifications.js";
import type { ProgressReportPdfBuilder } from "./run-progress-reports.js";
import { getDataSource } from "../../datasource/factory.js";
import {
  buildProgressPdfData,
  type TenantInfo,
} from "../progress-pdf.js";
import { ProgressPdfDocument } from "../progress-pdf-document.js";

export interface DispatchFactoryOutput {
  storage: DispatchStorage;
  loader: TenantDataLoader;
  env: DispatchEnv;
  expectedAudience: string;
  verifier: OidcTokenVerifier;
  /**
   * Phase 3 PR 3c: 進捗レポートレーン用 PDF 生成 builder (Codex セカンドオピニオン HIGH #2 反映)。
   * production では `getDataSource + buildProgressPdfData + ProgressPdfDocument + renderToBuffer`
   * の wrapper、in-memory では簡易 stub を返す。
   */
  progressPdfBuilder: ProgressReportPdfBuilder;
  /** 切り替えモードの可視化 (logging 用) */
  mode: "firestore" | "in-memory";
}

/**
 * Production PDF builder: tenant doc を Firestore から読み、`getDataSource` 経由で
 * tenant scope の DataSource を作り、`buildProgressPdfData` + `ProgressPdfDocument` +
 * `renderToBuffer` で PDF Buffer を生成し、5MB 上限判定を行う。
 *
 * 設計仕様書 §6.1: PDF 生成は run-progress-reports.ts 範囲外の責務とし、本 factory で
 * inject する形を採用 (test 容易性確保 + 関心事分離)。
 */
async function buildProductionPdf(
  tenantId: string,
  userId: string,
  now: Date,
): Promise<
  | { kind: "ready"; pdfData: Awaited<ReturnType<typeof buildProgressPdfData>>; pdfBuffer: Buffer }
  | { kind: "pdf_too_large"; sizeBytes: number }
> {
  const db = getFirestore();
  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  const tenantData = tenantDoc.data() ?? {};
  const tenant: TenantInfo = {
    id: tenantId,
    name: typeof tenantData.name === "string" ? tenantData.name : tenantId,
    ownerEmail:
      typeof tenantData.ownerEmail === "string" && tenantData.ownerEmail.length > 0
        ? tenantData.ownerEmail
        : null,
  };
  const dataSource = getDataSource({ tenantId, isDemo: false });
  const pdfData = await buildProgressPdfData({
    dataSource,
    tenant,
    userId,
    now,
  });
  // すべての section を含める (進捗レポートは手動 draft と異なり、定期配信では情報量を絞らない)
  const allSections = {
    profile: true,
    deadline: true,
    summary: true,
    lessons: true,
    quiz: true,
    pace: true,
    video: true,
  } as const;
  const pdfBuffer = await renderToBuffer(
    ProgressPdfDocument({ data: pdfData, sections: allSections }),
  );
  if (pdfBuffer.length > DISPATCH_CONSTRAINTS.PROGRESS_REPORT_PDF_MAX_BYTES) {
    return { kind: "pdf_too_large", sizeBytes: pdfBuffer.length };
  }
  return { kind: "ready", pdfData, pdfBuffer };
}

/** In-memory 用の最小 stub PDF builder (dev / E2E test 用、本番では呼ばれない) */
const inMemoryPdfBuilder: ProgressReportPdfBuilder = async ({ tenantId, user, now }) => {
  // shape を満たす最小 ProgressPdfData (in-memory test 用、実 PDF 内容は意味を持たない)
  const pdfData = {
    generatedAt: now.toISOString(),
    user: { id: user.id, name: user.name, email: user.email },
    tenant: { id: tenantId, name: tenantId, ownerEmail: null },
    deadline: {
      enrolledAt: null,
      deadlineBaseDate: null,
      videoAccessUntil: null,
      quizAccessUntil: null,
      daysRemainingVideo: null,
      daysRemainingQuiz: null,
    },
    courses: [],
    pace: {
      status: "ongoing" as const,
      remainingLessons: 0,
      remainingDays: null,
      lessonsPerWeek: null,
      minutesPerDay: null,
    },
    videoSummary: { totalWatchedSec: 0, totalDurationSec: 0 },
  };
  // 最小 PDF stub (Buffer 0 byte でも buildMessageMime は構造的に有効、AC-PR-12 はテスト [15] で確認済)
  return { kind: "ready" as const, pdfData, pdfBuffer: Buffer.from("%PDF-1.4 in-memory stub") };
};

/**
 * 環境変数から必須値を読む (未設定なら明示 throw、silent fallback しない)。
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Dispatch factory: env var "${name}" is required but missing or empty`,
    );
  }
  return value.trim();
}

/**
 * Production wiring: Cloud Run / Firestore 実体に接続。
 *
 * test / E2E では `DISPATCH_USE_IN_MEMORY=true` を設定するか、createInternalDispatchRouter を
 * 直接呼んで test 用 storage / loader を inject する。
 *
 * env 解決方針 (code-review PLAUSIBLE 反映):
 *   - production (DISPATCH_USE_IN_MEMORY != "true"): 必須 env を requireEnv で強制
 *   - in-memory モード (DISPATCH_USE_IN_MEMORY == "true"): test/dev 想定で env を任意化、
 *     未設定なら mock デフォルト値を採用する (in-memory のため Gmail 実送信は発生しない)
 */
const IN_MEMORY_DEFAULTS = {
  subjectEmail: "in-memory-subject@example.invalid",
  fromEmail: "in-memory-from@example.invalid",
  expectedAudience: "https://in-memory.example.invalid",
} as const;

/**
 * GCP runtime 検出 (Cloud Run / Cloud Functions / GAE)。
 * 本番 runtime では in-memory モード採用を拒否する (silent no-op 防止、Codex Important 反映)。
 */
function isProductionGcpRuntime(): boolean {
  return Boolean(
    process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET ||
      process.env.FUNCTION_NAME ||
      process.env.GAE_SERVICE,
  );
}

export function buildDispatchFactory(): DispatchFactoryOutput {
  const useInMemory = process.env.DISPATCH_USE_IN_MEMORY === "true";

  if (useInMemory) {
    // 本番 GCP runtime で DISPATCH_USE_IN_MEMORY=true は誤設定の可能性が極めて高い。
    // in-memory storage は永続化されず、Gmail 実送信もスキップされるため、本番で混入
    // すると Cloud Scheduler 起動が常に 200 empty response (silent no-op) になる。
    // Codex Important 反映: 本番 runtime 検出時は throw して fail loud。
    if (isProductionGcpRuntime()) {
      throw new Error(
        "Dispatch factory: DISPATCH_USE_IN_MEMORY=true is forbidden in production GCP runtime " +
          "(detected K_SERVICE/FUNCTION_TARGET/FUNCTION_NAME/GAE_SERVICE). " +
          "Unset DISPATCH_USE_IN_MEMORY or run outside Cloud Run/Functions/GAE.",
      );
    }
    const subjectEmail =
      process.env.DXCOLLEGE_DISPATCH_SUBJECT?.trim() || IN_MEMORY_DEFAULTS.subjectEmail;
    const fromEmail =
      process.env.DXCOLLEGE_SENDER_EMAIL?.trim() || IN_MEMORY_DEFAULTS.fromEmail;
    const expectedAudience =
      process.env.DISPATCH_OIDC_AUDIENCE?.trim() || IN_MEMORY_DEFAULTS.expectedAudience;
    return {
      storage: new InMemoryDispatchStorage(),
      loader: new InMemoryTenantDataLoader(),
      env: { subjectEmail, fromEmail },
      expectedAudience,
      verifier: new GoogleOidcTokenVerifier(),
      progressPdfBuilder: inMemoryPdfBuilder,
      mode: "in-memory",
    };
  }

  // production: env 必須 + Firestore 実装 + Google OIDC verifier
  const subjectEmail = requireEnv("DXCOLLEGE_DISPATCH_SUBJECT");
  const fromEmail = requireEnv("DXCOLLEGE_SENDER_EMAIL");
  const expectedAudience = requireEnv("DISPATCH_OIDC_AUDIENCE");
  const env: DispatchEnv = { subjectEmail, fromEmail };
  const db = getFirestore();
  return {
    storage: new FirestoreDispatchStorage(db),
    loader: new FirestoreTenantDataLoader(db),
    env,
    expectedAudience,
    verifier: new GoogleOidcTokenVerifier(),
    // production PDF builder wiring (Codex セカンドオピニオン HIGH #2 反映)
    progressPdfBuilder: async ({ tenantId, user, now }) =>
      buildProductionPdf(tenantId, user.id, now),
    mode: "firestore",
  };
}
