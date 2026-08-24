import { describe, it, expect, vi } from "vitest";
import { createFakeFirestore } from "../storage/__tests__/fake-firestore.js";
import { createTenantMembershipChecker } from "../tenant-membership.js";

describe("tenant-membership: createTenantMembershipChecker", () => {
  it("tenants/{tenant}/allowed_emailsにemailが存在すればmemberを返す", async () => {
    const db = createFakeFirestore();
    await db.collection("tenants/tenant-a/allowed_emails").doc("doc1").set({ email: "user@example.com" });
    const checker = createTenantMembershipChecker(db);

    const result = await checker.checkMembership("tenant-a", "user@example.com");
    expect(result).toBe("member");
  });

  it("tenants/{tenant}/allowed_emailsにemailが存在しなければdeniedを返す", async () => {
    const db = createFakeFirestore();
    await db.collection("tenants/tenant-a/allowed_emails").doc("doc1").set({ email: "other@example.com" });
    const checker = createTenantMembershipChecker(db);

    const result = await checker.checkMembership("tenant-a", "user@example.com");
    expect(result).toBe("denied");
  });

  it("emailの大文字・前後空白を正規化してから照合する", async () => {
    const db = createFakeFirestore();
    await db.collection("tenants/tenant-a/allowed_emails").doc("doc1").set({ email: "user@example.com" });
    const checker = createTenantMembershipChecker(db);

    const result = await checker.checkMembership("tenant-a", "  USER@Example.com  ");
    expect(result).toBe("member");
  });

  it("別テナントのallowed_emailsは参照しない（テナント間の越境判定漏れがないこと）", async () => {
    const db = createFakeFirestore();
    await db.collection("tenants/tenant-a/allowed_emails").doc("doc1").set({ email: "user@example.com" });
    const checker = createTenantMembershipChecker(db);

    const result = await checker.checkMembership("tenant-b", "user@example.com");
    expect(result).toBe("denied");
  });

  it("Firestoreクエリ自体が例外を投げた場合はfail-closedでdeniedを返す", async () => {
    const db = {
      collection: () => ({
        where: () => ({
          limit: () => ({
            get: vi.fn().mockRejectedValue(new Error("firestore unavailable")),
          }),
        }),
      }),
    } as unknown as Parameters<typeof createTenantMembershipChecker>[0];
    const checker = createTenantMembershipChecker(db);

    const result = await checker.checkMembership("tenant-a", "user@example.com");
    expect(result).toBe("denied");
  });
});
