import cors from "cors";
import express from "express";
import helmet from "helmet";
import { initializeApp, getApps } from "firebase-admin/app";
import { tenantAwareAuthMiddleware } from "./middleware/tenant-auth.js";
import { resetE2eDataSource } from "./datasource/factory.js";
import {
  tenantMiddleware,
  demoAuthMiddleware,
  demoReadOnlyMiddleware,
  dataSourceErrorHandler,
} from "./middleware/tenant.js";
import { globalLimiter, authLimiter } from "./middleware/rate-limiter.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createSharedRouter } from "./routes/shared/index.js";
import { tenantsRouter } from "./routes/tenants.js";
import { superAdminRouter } from "./routes/super-admin.js";
import { helpRoleRouter } from "./routes/help-role.js";
import { publicRouter } from "./routes/public.js";
import { createInternalDispatchRouter } from "./routes/internal/dispatch.js";
import { createDispatchSuperRouter } from "./routes/super/dispatch-super-router.js";
import {
  InMemoryTenantCcConfigStore,
  parseSeedTenantIds,
} from "./routes/super/tenant-notification-cc.js";
import { superAdminAuthMiddleware } from "./middleware/super-admin.js";
import { buildDispatchFactory } from "./services/dispatch/factory.js";
import { logger } from "./utils/logger.js";
import { getFirestore } from "firebase-admin/firestore";

// Firebase Admin初期化（エミュレータ対応）
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || "lms-279";
if (getApps().length === 0) {
  initializeApp({ projectId });
  logger.info("Firebase Admin initialized", { projectId });
}

const app = express();

// Cloud Run等リバースプロキシ経由時にクライアントIPを正しく取得
app.set("trust proxy", 1);

// セキュリティヘッダ（Helmet）
app.use(helmet());

// CORS設定
const corsOrigins = process.env.CORS_ORIGIN?.split(",");
if (!corsOrigins && process.env.NODE_ENV === "production") {
  throw new Error("CORS_ORIGIN must be set in production");
}
app.use(cors({
  origin: corsOrigins ?? ["http://localhost:3000", "http://localhost:3001"],
  credentials: true,
}));
app.use(express.json());

// デモモード設定
const DEMO_ENABLED = process.env.DEMO_ENABLED === "true";

// GCP認証検出（プロセス起動時に1回だけ評価）
const HAS_GCP_CREDENTIALS = !!(
  process.env.FIRESTORE_EMULATOR_HOST ||
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  process.env.K_SERVICE // Cloud Run上で自動提供される
);

const FIRESTORE_PROBE_TIMEOUT_MS = 5_000;

// Readiness チェックの型定義
type FirestoreStatus = "ok" | "error" | "skipped";
interface HealthChecks {
  firestore: FirestoreStatus;
  memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number };
}

// ヘルスチェック（認証不要・レート制限対象外）
app.get(["/health", "/healthz", "/api/health"], (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness チェック（Firestore接続 + メモリ使用量、レート制限対象外）
app.get("/health/ready", async (_req, res) => {
  let firestoreStatus: FirestoreStatus = "skipped";

  if (HAS_GCP_CREDENTIALS) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const db = getFirestore();
      await Promise.race([
        db.doc("_health/probe").get(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("timeout")), FIRESTORE_PROBE_TIMEOUT_MS);
        }),
      ]);
      firestoreStatus = "ok";
    } catch (err) {
      firestoreStatus = "error";
      logger.warn("Firestore health check failed", { error: String(err) });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const mem = process.memoryUsage();
  const checks: HealthChecks = {
    firestore: firestoreStatus,
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
  };

  const healthy = firestoreStatus !== "error";
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
});

// レート制限（ヘルスチェックの後に配置し、プローブを除外）
app.use(globalLimiter);

// リクエストログ
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.url}`, { method: req.method, url: req.url });
  next();
});

// ========================================
// ルーターのマウント
// ========================================

// E2Eテスト用: DataSourceリセット（E2E_TEST_ENABLED=true時のみ）
if (process.env.E2E_TEST_ENABLED === "true") {
  app.post("/api/v2/e2e-test/__reset", (_req, res) => {
    resetE2eDataSource();
    res.status(204).end();
  });
}

// 認証不要の公開API（ADR-031 Phase 3 / Sub-Issue B）
// FE ログイン前テナント解決（gcipTenantId 取得）用。rate limit 適用必須。
app.use("/api/v2/public", authLimiter, publicRouter);

// テナント登録API（認証のみ、テナントコンテキスト不要）
app.use("/api/v2/tenants", authLimiter, tenantsRouter);

// 内部 API: Cloud Scheduler 経由の自動完了通知配信 (Phase 7 wiring)
//
// env 解決方針:
//   - GCP runtime (Cloud Run / Cloud Functions / GAE) では env 欠如 / 初期化失敗を
//     silent skip しない (本番で Scheduler が 404 を受けても 2xx 期待で気付かない
//     リスク回避、evaluator HIGH + Codex Important 反映)
//   - local dev / E2E (GCP runtime シグナルなし) では warn + skip
//
// GCP runtime 判定: Cloud Run = K_SERVICE / Cloud Functions = FUNCTION_TARGET or
//   FUNCTION_NAME / GAE = GAE_SERVICE を網羅 (LMS は現状 Cloud Run のみだが、防御的に
//   全 GCP runtime を fail loud 対象とする)
function isProductionGcpRuntime(): boolean {
  return Boolean(
    process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET ||
      process.env.FUNCTION_NAME ||
      process.env.GAE_SERVICE,
  );
}

// Phase 5: 配信設定 super API は superAdminRouter の後に mount するため factory を hoist。
let dispatchFactory: ReturnType<typeof buildDispatchFactory> | null = null;

try {
  dispatchFactory = buildDispatchFactory();
  app.use(
    "/api/v2/internal",
    createInternalDispatchRouter({
      expectedAudience: dispatchFactory.expectedAudience,
      verifier: dispatchFactory.verifier,
      storage: dispatchFactory.storage,
      loader: dispatchFactory.loader,
      env: dispatchFactory.env,
    }),
  );
  logger.info("Internal dispatch router mounted", { mode: dispatchFactory.mode });
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  if (isProductionGcpRuntime()) {
    // 本番 GCP runtime で env 欠如 = fail loud (silent skip 防止)
    logger.error(
      "Internal dispatch router failed to mount in production GCP runtime — env missing or init failed",
      { errorType: "dispatch_router_mount_failed_in_production", error: errorMsg },
    );
    throw err;
  }
  // local dev / E2E: warn + skip (dispatch endpoint は本番のみ必要)
  logger.warn("Internal dispatch router NOT mounted (env missing or init failed)", {
    error: errorMsg,
  });
}

// スーパー管理者API
app.use("/api/v2/super", superAdminRouter);

// スーパー管理者 配信設定 API (Phase 5)。superAdminRouter の後に mount し、
// dispatch 固有パスは superAdminRouter で未マッチ → fall-through で本ルータが処理する。
// 明示的に superAdminAuthMiddleware を適用し、auth 依存を self-contained にする
// (本番 GCP で factory build 失敗時は dispatchFactory=null となり mount をスキップ)。
if (dispatchFactory) {
  // in-memory モード時のみ、ccStore も in-memory に差し替える
  // (FirestoreTenantCcConfigStore は Firestore credential 必須で CI / dev で 500)。
  // seed tenant は env DISPATCH_IN_MEMORY_SEED_TENANTS (カンマ区切り) で指定。
  // 本番 (firestore mode) では undefined を渡し、router default の Firestore wiring を使う。
  let inMemoryCcStore: InMemoryTenantCcConfigStore | undefined;
  if (dispatchFactory.mode === "in-memory") {
    const seedTenantIds = parseSeedTenantIds(
      process.env.DISPATCH_IN_MEMORY_SEED_TENANTS,
    );
    inMemoryCcStore = new InMemoryTenantCcConfigStore({ seedTenantIds });
    // operator UX: env 未設定 / 誤設定で seedTenantIds が空のまま起動すると
    // GET /tenants/:id/notification-cc-emails が常に 404 になり原因切り分けが
    // 遅れるため、採用値を startup log に明示する (review feedback 反映)。
    logger.info("Super dispatch router: in-memory ccStore seeded", {
      seedTenantIds,
    });
  }

  app.use(
    "/api/v2/super",
    superAdminAuthMiddleware,
    createDispatchSuperRouter({
      storage: dispatchFactory.storage,
      loader: dispatchFactory.loader,
      env: dispatchFactory.env,
      ccStore: inMemoryCcStore,
    }),
  );
  logger.info("Super dispatch router mounted", { mode: dispatchFactory.mode });
}

// ヘルプロール判定API（テナントコンテキスト不要）
app.use("/api/v2/help", helpRoleRouter);

// テナントスコープAPI: /api/v2/:tenant/*
app.use(
  "/api/v2/:tenant",
  tenantMiddleware,
  demoAuthMiddleware,
  tenantAwareAuthMiddleware,
  demoReadOnlyMiddleware,
  createSharedRouter()
);

// エラーハンドラ（順序重要: DataSource → 404 → グローバル）
app.use(dataSourceErrorHandler);
app.use(notFoundHandler);
app.use(errorHandler);

const port = Number(process.env.PORT || 8080);
const server = app.listen(port, async () => {
  // 起動時に env var で決まる主要設定値の採用値をログする（env タイポで silent fallback 発生時の検知のため）
  const { SESSION_DURATION_MS } = await import("./services/lesson-session.js");
  const { PAUSE_TIMEOUT_MS } = await import("./routes/shared/video-events.js");
  logger.info("LMS API service started", {
    port,
    sessionDurationMs: SESSION_DURATION_MS,
    pauseTimeoutMs: PAUSE_TIMEOUT_MS,
    routes: [
      "/health, /healthz, /api/health",
      "/api/v2/public/*",
      "/api/v2/tenants",
      "/api/v2/super/*",
      "/api/v2/:tenant/*",
      ...(DEMO_ENABLED ? ["/api/v2/demo/*"] : []),
    ],
  });
});

// グレースフルシャットダウン
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

export default app;
