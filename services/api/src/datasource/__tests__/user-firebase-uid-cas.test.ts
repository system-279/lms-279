/**
 * setUserFirebaseUidIfUnset の CAS セマンティクステスト (Issue #313 / ADR-031)
 *
 * 並行ログイン / GCIP UID 揺り戻しによる last-write-wins を防止する CAS (compare-and-set)
 * 動作を検証する。
 *
 * 注: 本ファイルは InMemory 実装のみ検証する。CAS の I/F 契約 (SetFirebaseUidResult の
 * 4 状態 + precondition) は Firestore / InMemory 両実装で共有しているが、Firestore の
 * runTransaction による実際の race セマンティクスは JS シングルスレッド環境では再現不能で、
 * Sub-Issue H の Staging 統合環境で別途検証する（ADR-028 テスト戦略に準拠）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataSource } from "../in-memory.js";

describe("InMemoryDataSource.setUserFirebaseUidIfUnset (Issue #313 CAS セマンティクス)", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("firebaseUid 未設定の user に CAS 更新すると status: updated + user 返却", async () => {
    const user = await ds.createUser({
      email: "a@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });

    const result = await ds.setUserFirebaseUidIfUnset(user.id, "uid-new");

    expect(result.status).toBe("updated");
    if (result.status === "updated") {
      expect(result.user.id).toBe(user.id);
      expect(result.user.firebaseUid).toBe("uid-new");
    }

    // 永続化確認
    const fetched = await ds.getUserById(user.id);
    expect(fetched?.firebaseUid).toBe("uid-new");
  });

  it("同じ firebaseUid で再 CAS すると status: already_set_same (idempotent)", async () => {
    const user = await ds.createUser({
      email: "b@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });
    await ds.setUserFirebaseUidIfUnset(user.id, "uid-x");

    const result = await ds.setUserFirebaseUidIfUnset(user.id, "uid-x");

    expect(result.status).toBe("already_set_same");
    if (result.status === "already_set_same") {
      expect(result.user.firebaseUid).toBe("uid-x");
    }
  });

  it("既に別 UID が設定済みの user に CAS すると status: conflict + existingUid 返却", async () => {
    const user = await ds.createUser({
      email: "c@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });
    await ds.setUserFirebaseUidIfUnset(user.id, "uid-original");

    const result = await ds.setUserFirebaseUidIfUnset(user.id, "uid-different");

    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.existingUid).toBe("uid-original");
    }

    // 既存 UID が上書きされていないこと (silent last-write-wins 防止)
    const fetched = await ds.getUserById(user.id);
    expect(fetched?.firebaseUid).toBe("uid-original");
  });

  it("存在しない userId に CAS すると status: not_found", async () => {
    const result = await ds.setUserFirebaseUidIfUnset("user-nonexistent", "uid-new");

    expect(result.status).toBe("not_found");
  });

  it("firebaseUid が空文字で保存された user は 'unset' とみなされ CAS で updated (backfill 前の移行アーティファクト防御)", async () => {
    const user = await ds.createUser({
      email: "empty@example.com",
      name: null,
      role: "student",
      firebaseUid: "" as unknown as string,
    });

    const result = await ds.setUserFirebaseUidIfUnset(user.id, "uid-new");

    expect(result.status).toBe("updated");
    const fetched = await ds.getUserById(user.id);
    expect(fetched?.firebaseUid).toBe("uid-new");
  });

  it("引数 firebaseUid が空文字 → precondition エラー throw", async () => {
    const user = await ds.createUser({
      email: "bad-arg@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });

    await expect(ds.setUserFirebaseUidIfUnset(user.id, "")).rejects.toThrow(
      /non-empty string/
    );
  });

  it("並行 race: Promise.all で 2 本同時実行 → 勝者 1 本のみ updated、敗者は conflict", async () => {
    const user = await ds.createUser({
      email: "race@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });

    // 2 本の CAS を「ほぼ同時」に発火
    const [result1, result2] = await Promise.all([
      ds.setUserFirebaseUidIfUnset(user.id, "uid-session-a"),
      ds.setUserFirebaseUidIfUnset(user.id, "uid-session-b"),
    ]);

    // 勝者は updated、敗者は conflict (順序は InMemory の実装依存だが、片方は必ず updated)
    const statuses = [result1.status, result2.status].sort();
    expect(statuses).toEqual(["conflict", "updated"]);

    const fetched = await ds.getUserById(user.id);
    expect(fetched?.firebaseUid).toMatch(/^uid-session-[ab]$/);
  });
});
