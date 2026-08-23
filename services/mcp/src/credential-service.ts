import { decryptWithKeyring } from "./crypto/aes-gcm.js";
import type { CredentialStore } from "./storage/credential-store.js";
import { encryptWithActiveKey, type CredentialKeyring } from "./credential-keys.js";
import {
  exchangeRefreshToken as defaultExchangeRefreshToken,
  TokenExchangeError,
  type ExchangedTokens,
} from "./firebase-token-exchange.js";
import { logger } from "./logger.js";

/**
 * uid（Firebase UID）を起点に、保存済み暗号化リフレッシュトークンを復号 →
 * securetoken.googleapis.com で新しいIDトークンへ交換 → ローテートされた
 * refreshTokenを再暗号化して保存 → idTokenを返す、一連の流れをまとめる。
 *
 * 同一プロセス内の短期キャッシュ(既定55分、IDトークンの実TTLは60分)を持ち、
 * `createApp`スコープで一度だけ生成されるため同一Cloud Runインスタンス内の
 * 複数リクエストで有効（計画 linear-zooming-conway.md「PR A」節参照）。
 *
 * 本PR時点では app.ts / index.ts / mcp-server.ts のどこからも呼ばれていない
 * （書き込み経路=サインイン時のrefreshToken捕捉のみが本PRのスコープ）。
 * quiz読み取りツール実装PR（Phase 2a）で mcp-server.ts のツールハンドラから
 * 呼び出される想定（pr-review-toolkitセカンドオピニオン指摘、2026-08-23）。
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

    let refreshToken: string;
    try {
      refreshToken = decryptWithKeyring(stored.encryptedRefreshToken, keyring.keys);
    } catch (error) {
      // 破損データ・鍵バージョン喪失等で復号できない暗号文は、修復手段がなく
      // 永久に同じ不透明なエラーを繰り返す（silent-failure-hunterセカンドオピニオン
      // 指摘、2026-08-23）。ログを残し、revokedと同様に削除して次回以降は
      // 明示的なCredentialNotFoundError（再認証が必要）にする。
      logger.error("Failed to decrypt stored Firebase refresh token; treating credential as unusable", {
        uid,
        error: String(error),
      });
      try {
        await store.delete(uid);
      } catch (deleteError) {
        logger.error("Failed to delete undecryptable credential", { uid, error: String(deleteError) });
      }
      throw new CredentialNotFoundError(uid);
    }

    let exchanged: ExchangedTokens;
    try {
      exchanged = await exchange(refreshToken, firebaseWebApiKey);
    } catch (error) {
      // revoked:true（TOKEN_EXPIRED等、refresh token自体が失効）の場合のみ削除する。
      // 失効済みトークンを保存したままにすると次回以降も同じ失敗を繰り返し、
      // Firestore にゴミとして残り続ける（code reviewセカンドオピニオン指摘）。
      // 削除しておけば、次回呼び出しは CredentialNotFoundError で
      // 「再認証が必要」であることを一貫して呼び出し元へ伝えられる。
      // permanentだがrevoked:falseの場合（API key不正等の設定不備）は削除しない
      // — 設定ミス1件で全ユーザーの再認証を強制することを避けるため
      // （codex review再指摘、2026-08-23）。
      if (error instanceof TokenExchangeError && error.revoked) {
        try {
          await store.delete(uid);
        } catch (deleteError) {
          logger.error("Failed to delete stale credential after permanent exchange error", {
            uid,
            error: String(deleteError),
          });
        }
      }
      throw error;
    }

    const reEncrypted = encryptWithActiveKey(exchanged.refreshToken, keyring);
    try {
      await store.save(uid, { encryptedRefreshToken: reEncrypted, keyVersion: keyring.activeVersion });
    } catch (saveError) {
      // exchange() が成功した時点で、Google側では古いrefresh tokenは既にローテート
      // 済み(=無効)。ここでの保存失敗は「古い資格情報がゴミとして残る」だけでなく
      // 「そのゴミは既に失効済みで二度と使えない」ことを意味する
      // （silent-failure-hunterセカンドオピニオン指摘CRITICAL、2026-08-23）。
      // 今回のリクエスト自体はidTokenを返せるためエラーにはしないが、次回以降が
      // 同じ無効な暗号文で不可解に失敗し続けないよう、古い資格情報を削除しておく。
      logger.error(
        "Firebase refresh token was rotated at Google but failed to persist the new value; deleting stale credential",
        { uid, error: String(saveError) }
      );
      try {
        await store.delete(uid);
      } catch (deleteError) {
        logger.error("Failed to delete stale credential after persist failure", { uid, error: String(deleteError) });
      }
    }

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
