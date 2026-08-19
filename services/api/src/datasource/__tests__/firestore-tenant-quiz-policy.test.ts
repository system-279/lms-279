/**
 * FirestoreDataSource.upsertTenantQuizPolicy / getTenantQuizPolicy / toTenantQuizPolicy の直接テスト
 *
 * boolean 2 値の読み取りは fail-closed（欠損・不正型は false に倒す）方針
 * （実装計画 imperative-bubbling-dijkstra.md 設計判断3・自白リスク3、codex plan review で妥当と評価）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { FirestoreDataSource } from "../firestore.js";
import { logger } from "../../utils/logger.js";

function buildMockDb(seed?: Record<string, unknown>) {
  const docState = new Map<string, { exists: boolean; id: string; data: () => Record<string, unknown> }>();
  if (seed) {
    docState.set("quiz_policy", { exists: true, id: "_config", data: () => seed });
  }

  const docRef = {
    get: vi.fn(async () => docState.get("quiz_policy") ?? { exists: false, id: "_config", data: () => ({}) }),
    set: vi.fn(async (data: Record<string, unknown>) => {
      docState.set("quiz_policy", { exists: true, id: "_config", data: () => data });
    }),
  };
  const collectionMock = vi.fn().mockReturnValue({ doc: vi.fn().mockReturnValue(docRef) });
  const db = { collection: collectionMock } as unknown as Firestore;
  return { db, docRef };
}

describe("FirestoreDataSource.upsertTenantQuizPolicy / getTenantQuizPolicy / toTenantQuizPolicy", () => {
  // logger.warn spy を使うテストが assertion 失敗で mockRestore() に到達しなかった場合でも、
  // 次のテストへ spy 状態が漏れないようにする防御（pr-review-toolkit 指摘対応の副次効果として追加）。
  afterEach(() => {
    vi.restoreAllMocks();
  });


  it("未設定（doc不在）のとき null を返す", async () => {
    const { db } = buildMockDb();
    const ds = new FirestoreDataSource(db, "acme");

    const result = await ds.getTenantQuizPolicy();

    expect(result).toBeNull();
  });

  it("set→get のラウンドトリップで値が保持される", async () => {
    const { db } = buildMockDb();
    const ds = new FirestoreDataSource(db, "acme");

    const upserted = await ds.upsertTenantQuizPolicy({
      quizSkipEnabled: true,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
    });
    expect(upserted.quizSkipEnabled).toBe(true);
    expect(upserted.pdfDownloadAllowedForSkipped).toBe(true);
    expect(upserted.updatedBy).toBe("admin@example.com");

    const fetched = await ds.getTenantQuizPolicy();
    expect(fetched).toEqual(upserted);
  });

  it("quizSkipEnabled=false かつ pdfDownloadAllowedForSkipped=true の組み合わせもそのまま保存・再読込される（master OFF 時のサブ設定保持）", async () => {
    const { db } = buildMockDb();
    const ds = new FirestoreDataSource(db, "acme");

    await ds.upsertTenantQuizPolicy({
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
    });

    const fetched = await ds.getTenantQuizPolicy();
    expect(fetched!.quizSkipEnabled).toBe(false);
    expect(fetched!.pdfDownloadAllowedForSkipped).toBe(true);
  });

  it("明示的な false が既存 true を上書きする（truthy 誤変換の回帰ガード）", async () => {
    const { db } = buildMockDb();
    const ds = new FirestoreDataSource(db, "acme");

    await ds.upsertTenantQuizPolicy({
      quizSkipEnabled: true,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
    });
    const updated = await ds.upsertTenantQuizPolicy({
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: false,
      updatedBy: "admin@example.com",
    });

    expect(updated.quizSkipEnabled).toBe(false);
    expect(updated.pdfDownloadAllowedForSkipped).toBe(false);
  });

  it("boolean フィールドが欠損したレガシー doc を読んでも false にフォールバックする（fail-closed）", async () => {
    const { db } = buildMockDb({
      updatedBy: "admin@example.com",
      updatedAt: "2026-06-01T00:00:00.000Z",
      // quizSkipEnabled / pdfDownloadAllowedForSkipped キー自体が存在しない
    });
    const ds = new FirestoreDataSource(db, "acme");

    const result = await ds.getTenantQuizPolicy();

    expect(result).not.toBeNull();
    expect(result!.quizSkipEnabled).toBe(false);
    expect(result!.pdfDownloadAllowedForSkipped).toBe(false);
  });

  it("boolean フィールドが非 boolean 型（文字列 \"true\"）の doc を読んでも false にフォールバックする（fail-closed）", async () => {
    const { db } = buildMockDb({
      quizSkipEnabled: "true",
      pdfDownloadAllowedForSkipped: "true",
      updatedBy: "admin@example.com",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const ds = new FirestoreDataSource(db, "acme");

    const result = await ds.getTenantQuizPolicy();

    expect(result).not.toBeNull();
    expect(result!.quizSkipEnabled).toBe(false);
    expect(result!.pdfDownloadAllowedForSkipped).toBe(false);
  });

  it("boolean フィールドが不正な型のとき logger.warn で検出可能にする（pr-review-toolkit 指摘対応: fail-closed が無言にならないことの回帰ガード）", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { db } = buildMockDb({
      quizSkipEnabled: "true",
      pdfDownloadAllowedForSkipped: false,
      updatedBy: "admin@example.com",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const ds = new FirestoreDataSource(db, "acme");

    await ds.getTenantQuizPolicy();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("不正な型"),
      expect.objectContaining({
        errorType: "tenant_quiz_policy_invalid_field_type",
        tenantId: "acme",
        documentId: "_config",
      }),
    );
    warnSpy.mockRestore();
  });

  it("boolean フィールドがすべて正しい型のとき logger.warn を呼ばない", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { db } = buildMockDb({
      quizSkipEnabled: true,
      pdfDownloadAllowedForSkipped: false,
      updatedBy: "admin@example.com",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const ds = new FirestoreDataSource(db, "acme");

    await ds.getTenantQuizPolicy();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
