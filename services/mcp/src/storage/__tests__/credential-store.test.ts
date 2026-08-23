import { describe, it, expect } from "vitest";
import { createCredentialStore } from "../credential-store.js";
import { createFakeFirestore } from "./fake-firestore.js";

describe("CredentialStore（Firestore mcp_user_credentials）", () => {
  it("save/find が往復する", async () => {
    const store = createCredentialStore(createFakeFirestore());

    await store.save("uid-1", { encryptedRefreshToken: "cipher-1", keyVersion: 1 });
    const found = await store.find("uid-1");

    expect(found).toEqual({ encryptedRefreshToken: "cipher-1", keyVersion: 1 });
  });

  it("存在しない uid の find は undefined を返す", async () => {
    const store = createCredentialStore(createFakeFirestore());

    const found = await store.find("nonexistent-uid");

    expect(found).toBeUndefined();
  });

  it("同じ uid への再 save は上書きする", async () => {
    const store = createCredentialStore(createFakeFirestore());

    await store.save("uid-1", { encryptedRefreshToken: "cipher-old", keyVersion: 1 });
    await store.save("uid-1", { encryptedRefreshToken: "cipher-new", keyVersion: 2 });
    const found = await store.find("uid-1");

    expect(found).toEqual({ encryptedRefreshToken: "cipher-new", keyVersion: 2 });
  });

  it("異なる uid は独立して保存される", async () => {
    const store = createCredentialStore(createFakeFirestore());

    await store.save("uid-1", { encryptedRefreshToken: "cipher-1", keyVersion: 1 });
    await store.save("uid-2", { encryptedRefreshToken: "cipher-2", keyVersion: 1 });

    expect(await store.find("uid-1")).toEqual({ encryptedRefreshToken: "cipher-1", keyVersion: 1 });
    expect(await store.find("uid-2")).toEqual({ encryptedRefreshToken: "cipher-2", keyVersion: 1 });
  });
});
