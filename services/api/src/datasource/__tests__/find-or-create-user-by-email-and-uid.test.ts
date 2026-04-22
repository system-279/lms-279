/**
 * findOrCreateUserByEmailAndUid のセマンティクステスト (Issue #316 / ADR-031)
 *
 * 「既存 user に対する CAS」と「新規 create」を同一 transaction で原子化することで、
 * findOrCreateTenantUser の「両方 miss → createUser」経路の並行リクエスト race を解消する。
 *
 * 注: 本ファイルは InMemory 実装のみ検証する。Firestore の真の race セマンティクスは
 * Sub-Issue H (Phase 3 Staging) で別途検証する (ADR-028 / Sub-Issue C テストと同方針)。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataSource } from "../in-memory.js";

const defaults = { name: "Test User", role: "student" as const };

describe("InMemoryDataSource.findOrCreateUserByEmailAndUid (Issue #316)", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("既存 user (firebaseUid 未設定) に対し → status: updated + user 返却", async () => {
    const existing = await ds.createUser({
      email: "existing@example.com",
      name: "Existing",
      role: "student",
      firebaseUid: undefined,
    });

    const result = await ds.findOrCreateUserByEmailAndUid(
      "existing@example.com",
      "uid-new",
      defaults
    );

    expect(result.status).toBe("updated");
    if (result.status === "updated") {
      expect(result.user.id).toBe(existing.id);
      expect(result.user.firebaseUid).toBe("uid-new");
      // 既存 name/role は保持される (defaults で上書きされない)
      expect(result.user.name).toBe("Existing");
    }
  });

  it("既存 user (同じ firebaseUid) に対し → status: already_set_same (idempotent)", async () => {
    const existing = await ds.createUser({
      email: "same@example.com",
      name: "Same",
      role: "teacher",
      firebaseUid: "uid-x",
    });

    const result = await ds.findOrCreateUserByEmailAndUid(
      "same@example.com",
      "uid-x",
      defaults
    );

    expect(result.status).toBe("already_set_same");
    if (result.status === "already_set_same") {
      expect(result.user.id).toBe(existing.id);
      expect(result.user.firebaseUid).toBe("uid-x");
      expect(result.user.role).toBe("teacher");
    }
  });

  it("既存 user (異なる firebaseUid) に対し → status: conflict + existingUid 返却、user 不変", async () => {
    await ds.createUser({
      email: "conflict@example.com",
      name: null,
      role: "student",
      firebaseUid: "uid-original",
    });

    const result = await ds.findOrCreateUserByEmailAndUid(
      "conflict@example.com",
      "uid-different",
      defaults
    );

    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.existingUid).toBe("uid-original");
    }
    // 既存 UID が silent 上書きされていないこと
    const fetched = await ds.getUserByEmail("conflict@example.com");
    expect(fetched?.firebaseUid).toBe("uid-original");
  });

  it("user 不在 → status: created + 引数 defaults で新規作成", async () => {
    const result = await ds.findOrCreateUserByEmailAndUid(
      "new@example.com",
      "uid-new",
      { name: "Brand New", role: "student" }
    );

    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.user.email).toBe("new@example.com");
      expect(result.user.firebaseUid).toBe("uid-new");
      expect(result.user.name).toBe("Brand New");
      expect(result.user.role).toBe("student");
      expect(result.user.id).toBeTruthy();
    }

    // 永続化確認
    const fetched = await ds.getUserByEmail("new@example.com");
    expect(fetched?.id).toBe(result.status === "created" ? result.user.id : "");
  });

  it("引数 firebaseUid が空文字 → precondition エラー throw", async () => {
    await expect(
      ds.findOrCreateUserByEmailAndUid("err@example.com", "", defaults)
    ).rejects.toThrow(/non-empty string/);
  });

  it("引数 email が空文字 → precondition エラー throw", async () => {
    await expect(
      ds.findOrCreateUserByEmailAndUid("", "uid-x", defaults)
    ).rejects.toThrow(/non-empty string/);
  });

  it("並行 race (新規 email, 異なる UID): Promise.all で 2 本 → user は 1 件のみ作成、勝者 created / 敗者 conflict", async () => {
    const [r1, r2] = await Promise.all([
      ds.findOrCreateUserByEmailAndUid("race@example.com", "uid-a", defaults),
      ds.findOrCreateUserByEmailAndUid("race@example.com", "uid-b", defaults),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["conflict", "created"]);

    // user は 1 件のみ
    const all = await ds.getUsers();
    const matched = all.filter((u) => u.email === "race@example.com");
    expect(matched).toHaveLength(1);
    // 勝者の UID で紐付けされている
    expect(matched[0].firebaseUid).toMatch(/^uid-[ab]$/);
  });

  it("並行 race (新規 email, 同 UID): Promise.all で 2 本 → user は 1 件のみ作成、勝者 created / 敗者 already_set_same", async () => {
    const [r1, r2] = await Promise.all([
      ds.findOrCreateUserByEmailAndUid("race-same@example.com", "uid-shared", defaults),
      ds.findOrCreateUserByEmailAndUid("race-same@example.com", "uid-shared", defaults),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["already_set_same", "created"]);

    const all = await ds.getUsers();
    const matched = all.filter((u) => u.email === "race-same@example.com");
    expect(matched).toHaveLength(1);
    expect(matched[0].firebaseUid).toBe("uid-shared");
  });

  it("並行 race (既存 user, 異 UID 2 本同時): user 不変、勝敗いずれも CAS セマンティクスに従う", async () => {
    await ds.createUser({
      email: "race-existing@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });

    const [r1, r2] = await Promise.all([
      ds.findOrCreateUserByEmailAndUid("race-existing@example.com", "uid-a", defaults),
      ds.findOrCreateUserByEmailAndUid("race-existing@example.com", "uid-b", defaults),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["conflict", "updated"]);

    const fetched = await ds.getUserByEmail("race-existing@example.com");
    expect(fetched?.firebaseUid).toMatch(/^uid-[ab]$/);
  });
});
