import { decryptWithKeyring } from "./crypto/aes-gcm.js";
import type { CredentialStore } from "./storage/credential-store.js";
import { encryptWithActiveKey, type CredentialKeyring } from "./credential-keys.js";
import { exchangeRefreshToken as defaultExchangeRefreshToken, type ExchangedTokens } from "./firebase-token-exchange.js";

/**
 * uid（Firebase UID）を起点に、保存済み暗号化リフレッシュトークンを復号 →
 * securetoken.googleapis.com で新しいIDトークンへ交換 → ローテートされた
 * refreshTokenを再暗号化して保存 → idTokenを返す、一連の流れをまとめる。
 *
 * 同一プロセス内の短期キャッシュ(既定55分、IDトークンの実TTLは60分)を持ち、
 * `createApp`スコープで一度だけ生成されるため同一Cloud Runインスタンス内の
 * 複数リクエストで有効（計画 linear-zooming-conway.md「PR A」節参照）。
 */

const CACHE_TTL_BUFFER_MS = 5 * 60 * 1000;

export class CredentialNotFoundError extends Error {
  constructor(uid: string) {
    super(`No stored Firebase credential for uid=${uid}. Re-authentication is required.`);
  }
}

interface CacheEntry {
  idToken: string;
  expiresAt: number;
}

export interface CredentialServiceDeps {
  store: CredentialStore;
  keyring: CredentialKeyring;
  firebaseWebApiKey: string;
  exchange?: (refreshToken: string, apiKey: string) => Promise<ExchangedTokens>;
  now?: () => number;
}

export interface CredentialService {
  getFirebaseIdTokenForAccount(uid: string): Promise<string>;
}

export function createCredentialService(deps: CredentialServiceDeps): CredentialService {
  const { store, keyring, firebaseWebApiKey } = deps;
  const exchange = deps.exchange ?? defaultExchangeRefreshToken;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();
  // 同一uidへの同時呼び出しがそれぞれ独立にrefresh tokenを読んで交換すると、
  // 交換のたびにGoogle側でrefresh tokenがローテートされるため、後発の呼び出しが
  // 既に無効化されたrefresh tokenでinvalid_grantになりうる（Codex review指摘、P2）。
  // 進行中の交換をuid単位で1本化し、後続の呼び出しは同じPromiseを待つ。
  const inflight = new Map<string, Promise<string>>();

  async function refreshAndCache(uid: string): Promise<string> {
    const stored = await store.find(uid);
    if (!stored) {
      throw new CredentialNotFoundError(uid);
    }

    const refreshToken = decryptWithKeyring(stored.encryptedRefreshToken, keyring.keys);
    const exchanged = await exchange(refreshToken, firebaseWebApiKey);

    const reEncrypted = encryptWithActiveKey(exchanged.refreshToken, keyring);
    await store.save(uid, { encryptedRefreshToken: reEncrypted, keyVersion: keyring.activeVersion });

    cache.set(uid, { idToken: exchanged.idToken, expiresAt: now() + exchanged.expiresIn * 1000 - CACHE_TTL_BUFFER_MS });
    return exchanged.idToken;
  }

  return {
    async getFirebaseIdTokenForAccount(uid: string): Promise<string> {
      const cached = cache.get(uid);
      if (cached && cached.expiresAt > now()) {
        return cached.idToken;
      }

      const existingInflight = inflight.get(uid);
      if (existingInflight) {
        return existingInflight;
      }

      const promise = refreshAndCache(uid).finally(() => {
        inflight.delete(uid);
      });
      inflight.set(uid, promise);
      return promise;
    },
  };
}
