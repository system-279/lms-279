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

// テナント登録API（認証のみ、テナントコンテキスト不要）
app.use("/api/v2/tenants", authLimiter, tenantsRouter);

// スーパー管理者API
app.use("/api/v2/super", superAdminRouter);

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
const server = app.listen(port, () => {
  logger.info("LMS API service started", {
    port,
    routes: [
      "/health, /healthz, /api/health",
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
