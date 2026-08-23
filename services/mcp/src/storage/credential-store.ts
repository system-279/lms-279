import type { Firestore } from "firebase-admin/firestore";

/**
 * Firebaseリフレッシュトークン（暗号化済み）の永続化先。ルートコレクション
 * `mcp_user_credentials`、doc id = uid（既存 `mcp_oauth_store` と同じルート配置方針、
 * storage/firestore-adapter.ts 参照）。
 *
 * Firebaseのリフレッシュトークンはユーザー削除・無効化・パスワード変更等の
 * 明示的イベントでのみ失効する仕組みのため、oidc-provider由来のトークン類のような
 * 短命TTLは設けない（計画 linear-zooming-conway.md「PR A」節参照）。
 */
const COLLECTION = "mcp_user_credentials";

export interface StoredCredential {
  encryptedRefreshToken: string;
  keyVersion: number;
}

export interface CredentialStore {
  save(uid: string, credential: StoredCredential): Promise<void>;
  find(uid: string): Promise<StoredCredential | undefined>;
}

export function createCredentialStore(db: Firestore): CredentialStore {
  const collection = () => db.collection(COLLECTION);

  return {
    async save(uid: string, credential: StoredCredential): Promise<void> {
      await collection()
        .doc(uid)
        .set({ ...credential, updatedAt: new Date() });
    },

    async find(uid: string): Promise<StoredCredential | undefined> {
      const snap = await collection().doc(uid).get();
      if (!snap.exists) return undefined;
      const data = snap.data() as (StoredCredential & { updatedAt?: unknown }) | undefined;
      if (!data) return undefined;
      return { encryptedRefreshToken: data.encryptedRefreshToken, keyVersion: data.keyVersion };
    },
  };
}
