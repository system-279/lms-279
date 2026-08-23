import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCredentialService, CredentialNotFoundError } from "../credential-service.js";
import { createCredentialStore } from "../storage/credential-store.js";
import { createFakeFirestore } from "../storage/__tests__/fake-firestore.js";
import { encryptWithKey } from "../crypto/aes-gcm.js";
import { TokenExchangeError, type ExchangedTokens } from "../firebase-token-exchange.js";
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

  it("revoked:trueなTokenExchangeError（失効したrefresh token）の場合、保存済み資格情報を削除し以後CredentialNotFoundErrorになる（code review指摘: ゴミの永続残留・無限リトライ防止）", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("revoked-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });

    exchangeMock.mockRejectedValue(new TokenExchangeError("TOKEN_EXPIRED", false, true));

    const service = createCredentialService({ store, keyring, firebaseWebApiKey: "api-key", exchange: exchangeMock });

    await expect(service.getFirebaseIdTokenForAccount("uid-1")).rejects.toThrow(TokenExchangeError);
    expect(await store.find("uid-1")).toBeUndefined();

    // 削除後の再呼び出しは「再認証が必要」を明示するCredentialNotFoundErrorになり、
    // 失効済みトークンでの無意味なexchange再試行を繰り返さない
    await expect(service.getFirebaseIdTokenForAccount("uid-1")).rejects.toBeInstanceOf(CredentialNotFoundError);
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });

  it("transientなTokenExchangeError（一時的な障害）の場合、保存済み資格情報は削除しない", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("still-valid-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });

    exchangeMock.mockRejectedValue(new TokenExchangeError("503", true));

    const service = createCredentialService({ store, keyring, firebaseWebApiKey: "api-key", exchange: exchangeMock });

    await expect(service.getFirebaseIdTokenForAccount("uid-1")).rejects.toThrow(TokenExchangeError);
    const stored = await store.find("uid-1");
    expect(stored?.encryptedRefreshToken).toBe(encrypted);
  });

  it("permanentだがrevoked:false（API key不正等の設定不備）のTokenExchangeErrorでは保存済み資格情報を削除しない（codex review指摘: 設定不備1件で全ユーザーの再認証を強制しないため）", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("still-valid-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });

    exchangeMock.mockRejectedValue(new TokenExchangeError("API key not valid", false, false));

    const service = createCredentialService({ store, keyring, firebaseWebApiKey: "api-key", exchange: exchangeMock });

    await expect(service.getFirebaseIdTokenForAccount("uid-1")).rejects.toThrow(TokenExchangeError);
    const stored = await store.find("uid-1");
    expect(stored?.encryptedRefreshToken).toBe(encrypted);
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

  it("同一uidへの同時呼び出しはexchangeを1回だけに合流させる（P2: レースコンディション対策）", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    const encrypted = encryptWithKey("original-refresh-token", keyring.keys[0]!.key, 1);
    await store.save("uid-1", { encryptedRefreshToken: encrypted, keyVersion: 1 });

    let resolveExchange: (value: { idToken: string; refreshToken: string; expiresIn: number }) => void;
    const pendingExchange = new Promise<{ idToken: string; refreshToken: string; expiresIn: number }>((resolve) => {
      resolveExchange = resolve;
    });
    exchangeMock.mockReturnValue(pendingExchange);

    const service = createCredentialService({ store, keyring, firebaseWebApiKey: "api-key", exchange: exchangeMock });

    // キャッシュもinflightも無い状態で2つの呼び出しをほぼ同時に開始する。
    // exchangeがまだ解決していない間に2件目のリクエストが来た場合の挙動を検証する。
    const call1 = service.getFirebaseIdTokenForAccount("uid-1");
    const call2 = service.getFirebaseIdTokenForAccount("uid-1");

    resolveExchange!({ idToken: "shared-id-token", refreshToken: "rotated-refresh-token", expiresIn: 3600 });
    const [result1, result2] = await Promise.all([call1, call2]);

    expect(result1).toBe("shared-id-token");
    expect(result2).toBe("shared-id-token");
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });

  it("異なるuidへの同時呼び出しはそれぞれ独立してexchangeされる", async () => {
    const keyring = makeKeyring();
    const store = createCredentialStore(createFakeFirestore());
    await store.save("uid-1", {
      encryptedRefreshToken: encryptWithKey("token-1", keyring.keys[0]!.key, 1),
      keyVersion: 1,
    });
    await store.save("uid-2", {
      encryptedRefreshToken: encryptWithKey("token-2", keyring.keys[0]!.key, 1),
      keyVersion: 1,
    });
    exchangeMock.mockImplementation(async (refreshToken: string) => ({
      idToken: `id-for-${refreshToken}`,
      refreshToken: `rotated-${refreshToken}`,
      expiresIn: 3600,
    }));

    const service = createCredentialService({ store, keyring, firebaseWebApiKey: "api-key", exchange: exchangeMock });

    const [result1, result2] = await Promise.all([
      service.getFirebaseIdTokenForAccount("uid-1"),
      service.getFirebaseIdTokenForAccount("uid-2"),
    ]);

    expect(result1).toBe("id-for-token-1");
    expect(result2).toBe("id-for-token-2");
    expect(exchangeMock).toHaveBeenCalledTimes(2);
  });
});
