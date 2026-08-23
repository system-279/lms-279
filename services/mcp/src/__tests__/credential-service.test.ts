import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCredentialService, CredentialNotFoundError } from "../credential-service.js";
import { createCredentialStore } from "../storage/credential-store.js";
import { createFakeFirestore } from "../storage/__tests__/fake-firestore.js";
import { encryptWithKey } from "../crypto/aes-gcm.js";
import type { ExchangedTokens } from "../firebase-token-exchange.js";
import { randomBytes } from "node:crypto";

function makeKeyring() {
  const key = randomBytes(32);
  return { keys: [{ version: 1, key }], activeVersion: 1 };
}

type ExchangeFn = (refreshToken: string, apiKey: string) => Promise<ExchangedTokens>;

describe("credential-service", () => {
  let exchangeMock: ReturnType<typeof vi.fn<ExchangeFn>>;

  beforeEach(() => {
    exchangeMock = vi.fn();
  });

  it("保存済みの暗号化refreshTokenを復号し交換してidTokenを返す", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("original-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });

    exchangeMock.mockResolvedValue({ idToken: "fresh-id-token", refreshToken: "rotated-refresh-token", expiresIn: 3600 });

    const service = createCredentialService({
      store,
      keyring,
      firebaseWebApiKey: "api-key",
      exchange: exchangeMock,
    });

    const idToken = await service.getFirebaseIdTokenForAccount("uid-1");

    expect(idToken).toBe("fresh-id-token");
    expect(exchangeMock).toHaveBeenCalledWith("original-refresh-token", "api-key");
  });

  it("交換で返ってきたローテート後のrefreshTokenを再暗号化して保存する", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("original-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });
    exchangeMock.mockResolvedValue({ idToken: "id-1", refreshToken: "rotated-refresh-token", expiresIn: 3600 });

    const service = createCredentialService({ store, keyring, firebaseWebApiKey: "api-key", exchange: exchangeMock });
    await service.getFirebaseIdTokenForAccount("uid-1");

    const stored = await store.find("uid-1");
    expect(stored?.keyVersion).toBe(1);
    // 保存されたrefreshTokenが新しい方（rotated-refresh-token）であることを、同じ鍵環で復号して確認
    const { decryptWithKeyring } = await import("../crypto/aes-gcm.js");
    expect(decryptWithKeyring(stored!.encryptedRefreshToken, keyring.keys)).toBe("rotated-refresh-token");
  });

  it("資格情報が未保存のuidに対しては CredentialNotFoundError を投げる", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const service = createCredentialService({ store, keyring, firebaseWebApiKey: "api-key", exchange: exchangeMock });

    await expect(service.getFirebaseIdTokenForAccount("unknown-uid")).rejects.toBeInstanceOf(CredentialNotFoundError);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("同一uidへの短時間内の連続呼び出しはキャッシュを使い、exchangeを再度呼ばない", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("original-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });
    exchangeMock.mockResolvedValue({ idToken: "id-1", refreshToken: "rotated-1", expiresIn: 3600 });

    let now = 1_000_000;
    const service = createCredentialService({
      store,
      keyring,
      firebaseWebApiKey: "api-key",
      exchange: exchangeMock,
      now: () => now,
    });

    await service.getFirebaseIdTokenForAccount("uid-1");
    now += 60_000; // 1分後
    const second = await service.getFirebaseIdTokenForAccount("uid-1");

    expect(second).toBe("id-1");
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });

  it("キャッシュ有効期限が過ぎたら再度exchangeを呼ぶ", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("original-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });
    exchangeMock
      .mockResolvedValueOnce({ idToken: "id-1", refreshToken: "rotated-1", expiresIn: 3600 })
      .mockResolvedValueOnce({ idToken: "id-2", refreshToken: "rotated-2", expiresIn: 3600 });

    let now = 1_000_000;
    const service = createCredentialService({
      store,
      keyring,
      firebaseWebApiKey: "api-key",
      exchange: exchangeMock,
      now: () => now,
    });

    await service.getFirebaseIdTokenForAccount("uid-1");
    now += 55 * 60 * 1000; // 55分後（3600秒のTTLに対し十分なバッファ経過）
    const second = await service.getFirebaseIdTokenForAccount("uid-1");

    expect(second).toBe("id-2");
    expect(exchangeMock).toHaveBeenCalledTimes(2);
  });
});
