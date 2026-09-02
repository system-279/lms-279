/**
 * Express app 定義。`index.ts` の `listen()` から分離し、supertest でポートを開かずに
 * テストできるようにする（クロスレビュー Medium #14 反映）。
 */

import express, { type Express } from "express";
import { Firestore } from "@google-cloud/firestore";
import {
  requireValidOidcToken,
  GoogleOidcTokenVerifier,
  type OidcTokenVerifier,
} from "./oidc-verify.js";
import { createHealthReportHandler } from "./health-report.js";
import { createErrorAlertHandler } from "./error-alert.js";
import { createAvailabilityAlertHandler } from "./availability-alert.js";
import { createFlushJobHandler } from "./flush-job.js";
import { FirestoreDedupStore, type DedupStore } from "./dedup.js";

const DEFAULT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface CreateAppOptions {
  db?: Firestore;
  dedupStore?: DedupStore;
  oidcVerifier?: OidcTokenVerifier;
  webhookSecretName?: string;
  apiHealthReadyUrl?: string;
  schedulerAudience?: string;
  schedulerCallerEmails?: string[];
  pubsubAudience?: string;
  pubsubCallerEmails?: string[];
  dedupWindowMs?: number;
}

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get(["/health", "/healthz"], (_req, res) => {
    res.json({ status: "ok" });
  });

  const webhookSecretName =
    opts.webhookSecretName ?? process.env.OPS_CHAT_WEBHOOK_SECRET_NAME ?? "";
  const db = opts.db ?? new Firestore();
  const dedupStore =
    opts.dedupStore ??
    new FirestoreDedupStore(db, opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS);
  const verifier = opts.oidcVerifier ?? new GoogleOidcTokenVerifier();

  const schedulerAuth = requireValidOidcToken({
    expectedAudience: opts.schedulerAudience ?? process.env.OPS_SCHEDULER_AUDIENCE ?? "",
    allowedCallerEmails: opts.schedulerCallerEmails ?? csvEnv("OPS_SCHEDULER_CALLER_EMAILS"),
    verifier,
  });
  const pubsubAuth = requireValidOidcToken({
    expectedAudience: opts.pubsubAudience ?? process.env.OPS_PUBSUB_AUDIENCE ?? "",
    allowedCallerEmails: opts.pubsubCallerEmails ?? csvEnv("OPS_PUBSUB_CALLER_EMAILS"),
    verifier,
  });

  app.post(
    "/internal/health-report",
    schedulerAuth,
    createHealthReportHandler({
      db,
      webhookSecretName,
      apiHealthReadyUrl:
        opts.apiHealthReadyUrl ?? process.env.OPS_API_HEALTH_READY_URL ?? "",
    })
  );

  app.post(
    "/internal/flush",
    schedulerAuth,
    createFlushJobHandler({ dedupStore, webhookSecretName })
  );

  app.post(
    "/internal/error-alert",
    pubsubAuth,
    createErrorAlertHandler({ dedupStore, webhookSecretName })
  );

  app.post(
    "/internal/availability-alert",
    pubsubAuth,
    createAvailabilityAlertHandler({ webhookSecretName })
  );

  return app;
}
