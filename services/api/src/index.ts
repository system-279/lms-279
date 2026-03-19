import cors from "cors";
import express from "express";
import helmet from "helmet";
import { initializeApp, getApps } from "firebase-admin/app";
import { tenantAwareAuthMiddleware } from "./middleware/tenant-auth.js";
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

// ヘルスチェック（認証不要・レート制限対象外）
app.get(["/health", "/healthz", "/api/health"], (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness チェック（Firestore接続 + メモリ使用量、レート制限対象外）
app.get("/health/ready", async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let healthy = true;

  // Firestore接続確認（タイムアウト5秒）
  try {
    const db = getFirestore();
    await Promise.race([
      db.listCollections(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    checks.firestore = "ok";
  } catch {
    checks.firestore = "error";
    healthy = false;
  }

  // メモリ使用量
  const mem = process.memoryUsage();
  checks.memory = {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
  };

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

// テナント登録API（認証のみ、テナントコンテキスト不要）
app.use("/api/v2/tenants", authLimiter, tenantsRouter);

// スーパー管理者API
app.use("/api/v2/super", superAdminRouter);

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
