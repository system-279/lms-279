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
import { createSharedRouter } from "./routes/shared/index.js";
import { tenantsRouter } from "./routes/tenants.js";
import { superAdminRouter } from "./routes/super-admin.js";

// Firebase Admin初期化（エミュレータ対応）
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || "lms-279";
if (getApps().length === 0) {
  initializeApp({ projectId });
  console.log(`Firebase Admin initialized with projectId: ${projectId}`);
}

const app = express();

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

// レート制限
app.use(globalLimiter);

// リクエストログ
app.use((req, _res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

// デモモード設定
const DEMO_ENABLED = process.env.DEMO_ENABLED === "true";

// ヘルスチェック（認証不要）
app.get(["/health", "/healthz", "/api/health"], (_req, res) => {
  res.json({ status: "ok" });
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

// DataSourceエラーハンドラ
app.use(dataSourceErrorHandler);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`LMS API service listening on :${port}`);
  console.log("Routes:");
  console.log("  - /health, /healthz, /api/health (health check)");
  console.log("  - /api/v2/tenants (tenant registration)");
  console.log("  - /api/v2/super/* (super admin API)");
  console.log("  - /api/v2/:tenant/* (tenant-based API)");
  if (DEMO_ENABLED) {
    console.log("  - /api/v2/demo/* (demo mode)");
  }
});

export default app;
