import { describe, it, expect, vi } from "vitest";
import { createAuditLog } from "../audit-log.js";
import { createFakeFirestore } from "../storage/__tests__/fake-firestore.js";
import { logger } from "../logger.js";

describe("createAuditLog", () => {
  it("record()呼び出しでmcp_audit_logsコレクションにドキュメントを書き込む", async () => {
    const db = createFakeFirestore();
    const auditLog = createAuditLog(db);

    await auditLog.record({
      actor: "uid-1",
      tenant: "tenant-a",
      tool: "list_courses",
      result: "success",
    });

    const snap = await db.collection("mcp_audit_logs").where("actor", "==", "uid-1").get();
    expect(snap.empty).toBe(false);
    expect(snap.docs[0]?.data()).toMatchObject({
      actor: "uid-1",
      tenant: "tenant-a",
      tool: "list_courses",
      result: "success",
    });
  });

  it("同一actorの複数回のrecord()はそれぞれ独立したドキュメントとして残る", async () => {
    const db = createFakeFirestore();
    const auditLog = createAuditLog(db);

    await auditLog.record({ actor: "uid-1", tenant: "tenant-a", tool: "list_courses", result: "success" });
    await auditLog.record({ actor: "uid-1", tenant: "tenant-a", tool: "get_quiz", result: "success" });

    const snap = await db.collection("mcp_audit_logs").where("actor", "==", "uid-1").get();
    expect(snap.docs).toHaveLength(2);
  });

  it("targetId/correlationIdを渡した場合はドキュメントに含める", async () => {
    const db = createFakeFirestore();
    const auditLog = createAuditLog(db);

    await auditLog.record({
      actor: "uid-1",
      tenant: "tenant-a",
      tool: "get_quiz",
      targetId: "lesson-1",
      correlationId: "corr-1",
      result: "success",
    });

    const snap = await db.collection("mcp_audit_logs").where("actor", "==", "uid-1").get();
    expect(snap.docs[0]?.data()).toMatchObject({ targetId: "lesson-1", correlationId: "corr-1" });
  });

  it("quiz本文・トークン等の機微情報はドキュメントに含めない（監査ログの設計制約）", async () => {
    const db = createFakeFirestore();
    const auditLog = createAuditLog(db);

    await auditLog.record({
      actor: "uid-1",
      tenant: "tenant-a",
      tool: "get_quiz",
      targetId: "lesson-1",
      result: "success",
    });

    const snap = await db.collection("mcp_audit_logs").where("actor", "==", "uid-1").get();
    const data = snap.docs[0]?.data();
    expect(Object.keys(data ?? {}).sort()).toEqual(
      ["actor", "createdAt", "result", "targetId", "tenant", "tool"].sort()
    );
  });

  it("Firestore書き込み失敗時はエラーをログし、例外を投げない（監査ログの障害でツール呼び出し自体を失敗させない）", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const failingDb = {
      collection: () => ({
        doc: () => ({
          set: vi.fn().mockRejectedValue(new Error("firestore unavailable")),
        }),
      }),
      // biome-ignore lint: fake-firestoreのFirestore型に合わせるための最小限のキャスト
    } as unknown as ReturnType<typeof createFakeFirestore>;
    const auditLog = createAuditLog(failingDb);

    await expect(
      auditLog.record({ actor: "uid-1", tenant: "tenant-a", tool: "list_courses", result: "success" })
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith("Failed to write mcp_audit_logs entry", expect.objectContaining({ actor: "uid-1" }));
    errorSpy.mockRestore();
  });

  it("Firestore書き込みが応答しない（ハング）場合でも、timeoutMsで打ち切りrecord()呼び出し元をブロックしない（codex review P2指摘: 監査ログが本来ブロックしない設計のはずが、Firestore劣化時にツール呼び出し自体を巻き込んで待たせてしまっていた）", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const hangingDb = {
      collection: () => ({
        doc: () => ({
          set: () => new Promise<void>(() => {}), // 永久に解決しない
        }),
      }),
    } as unknown as ReturnType<typeof createFakeFirestore>;
    const auditLog = createAuditLog(hangingDb, { timeoutMs: 50 });

    const startedAt = Date.now();
    await auditLog.record({ actor: "uid-1", tenant: "tenant-a", tool: "list_courses", result: "success" });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
    errorSpy.mockRestore();
  });

  it("Firestore書き込みがtimeoutMs内に成功した場合、タイムアウト後に偽の失敗ログを出さない（PR A router.tsの既知の落とし穴: タイマークリア漏れの再発防止）", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const db = createFakeFirestore();
    const auditLog = createAuditLog(db, { timeoutMs: 30 });

    await auditLog.record({ actor: "uid-1", tenant: "tenant-a", tool: "list_courses", result: "success" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const timeoutLogCalls = errorSpy.mock.calls.filter((call) => String(call[0]).includes("exceeded timeout"));
    expect(timeoutLogCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });
});
