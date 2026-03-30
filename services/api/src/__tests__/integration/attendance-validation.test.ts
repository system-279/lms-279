/**
 * 出席レコード編集（PATCH）の入力バリデーションテスト
 *
 * super-adminルーターのFirestoreアクセスの前に400が返ることを検証。
 * Firestoreの初期化が不要なため、バリデーションロジックのみの高速テスト。
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import supertest from "supertest";
import express from "express";

// Firebase Admin SDKのモック（super-admin.tsがimport時にgetFirestore()を使うため）
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(() => Promise.resolve({ exists: false })),
      })),
    })),
  })),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({
    verifyIdToken: vi.fn(),
  })),
}));

// super-admin認証をバイパス
vi.mock("../../middleware/super-admin.js", () => ({
  superAdminAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  getAllSuperAdmins: vi.fn(() => Promise.resolve([])),
  addSuperAdmin: vi.fn(),
  removeSuperAdmin: vi.fn(),
  isSuperAdmin: vi.fn(() => Promise.resolve(false)),
}));

describe("PATCH /attendance-report/:sessionId バリデーション", () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const { superAdminRouter } = await import("../../routes/super-admin.js");
    const app = express();
    app.use(express.json());
    app.use(superAdminRouter);
    request = supertest(app);
  });

  const endpoint = "/tenants/test-tenant/attendance-report/test-session";

  it("不正なentryAt形式で400を返す", async () => {
    const res = await request.patch(endpoint).send({ entryAt: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_entryAt");
  });

  it("不正なexitAt形式で400を返す", async () => {
    const res = await request.patch(endpoint).send({ exitAt: "2026-03-30" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_exitAt");
  });

  it("entryAt > exitAtで400を返す", async () => {
    const res = await request.patch(endpoint).send({
      entryAt: "2026-03-30T10:00:00.000Z",
      exitAt: "2026-03-30T09:00:00.000Z",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_time_range");
  });

  it("quizScoreが負数で400を返す", async () => {
    const res = await request.patch(endpoint).send({ quizScore: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_quizScore");
  });

  it("quizScoreが101で400を返す", async () => {
    const res = await request.patch(endpoint).send({ quizScore: 101 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_quizScore");
  });

  it("quizScoreがNaNで400を返す", async () => {
    const res = await request.patch(endpoint).send({ quizScore: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_quizScore");
  });

  it("quizPassedが文字列で400を返す", async () => {
    const res = await request.patch(endpoint).send({ quizPassed: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_quizPassed");
  });

  it("正しいISO日時はバリデーションを通過する", async () => {
    // Firestore側で404になるが、バリデーションは通過する
    const res = await request.patch(endpoint).send({
      entryAt: "2026-03-30T01:00:00.000Z",
      exitAt: "2026-03-30T03:00:00.000Z",
    });
    // 404 = バリデーション通過後にFirestoreでsession not found
    expect(res.status).toBe(404);
  });
});
