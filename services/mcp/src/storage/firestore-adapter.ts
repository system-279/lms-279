import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { errors, type Adapter, type AdapterFactory, type AdapterPayload } from "oidc-provider";
import { logger } from "../logger.js";

/**
 * oidc-provider の Adapter 実装（Firestore版）。単一コレクション `mcp_oauth_store` に
 * model フィールドで区別して保存する（PAR 等の新モデルが有効化されても TTL・index
 * 除外の設定漏れによる本番障害を起こさないため。計画 noble-purring-rabbit.md 参照）。
 */
const COLLECTION = "mcp_oauth_store";

/** Firestore ドキュメント id の実用上限（1500 byte）。攻撃者制御可能な id（client_id等）が
 * これを超える異常入力を送ってきた場合の防御。 */
const MAX_DOC_ID_BYTES = 1500;

/** TTL の猶予時間。TTL policy の反映ラグ（最大24時間程度）とは別に、find() 側でも
 * expiresAt を見て期限切れなら undefined を返す二重防御のための猶予。 */
const EXPIRY_GRACE_SECONDS = 300;

interface StoredDoc {
  model: string;
  payload: string;
  consumed?: number;
  uid?: string;
  grantId?: string;
  userCode?: string;
  expiresAt?: Timestamp;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function buildDocId(model: string, id: string): string {
  return `${model}:${toBase64Url(id)}`;
}

function isDocIdTooLong(docId: string): boolean {
  return Buffer.byteLength(docId, "utf8") > MAX_DOC_ID_BYTES;
}

/**
 * find() / findByField() 用の期限切れ判定。`Adapter.find(id)` は oidc-provider の
 * `ignoreExpiration` オプション（`findGrantSource` 等が再利用検知のため意図的に指定する、
 * `node_modules/oidc-provider/lib/helpers/grant_common.js` 参照）を受け取れないため、
 * この判定は ignoreExpiration の有無を区別できない。これは oidc-provider 既定の
 * MemoryAdapter も同様の制約を持つ（`storageOptions()` の maxAge により LRU 側で
 * TTL切れのエントリは取得できなくなる、`node_modules/oidc-provider/lib/adapters/
 * memory_adapter.js` 参照）ため、TTLベースの adapter に共通する許容されたトレードオフとして扱う。
 */
function isExpired(doc: StoredDoc): boolean {
  if (!doc.expiresAt) return false;
  return doc.expiresAt.toMillis() <= Date.now();
}

/** payload(JSON文字列) をパースし、トップレベル独立フィールドの consumed をマージして返す。
 * パース失敗はログのみで例外にしない（services/api/src/datasource/firestore.ts の
 * mapDocsResilient と同じ発想、1件の破損で呼び出し元全体を落とさない）。 */
function parsePayload(doc: StoredDoc, docId: string): AdapterPayload | undefined {
  let payload: AdapterPayload;
  try {
    payload = JSON.parse(doc.payload) as AdapterPayload;
  } catch (error) {
    logger.error("Failed to parse mcp_oauth_store payload", { docId, error: String(error) });
    return undefined;
  }
  if (doc.consumed !== undefined) {
    payload.consumed = doc.consumed;
  }
  return payload;
}

export class FirestoreOidcAdapter implements Adapter {
  constructor(
    private readonly db: Firestore,
    private readonly model: string
  ) {}

  private collection() {
    return this.db.collection(COLLECTION);
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const docId = buildDocId(this.model, id);
    if (isDocIdTooLong(docId)) {
      throw new Error(`mcp_oauth_store doc id exceeds Firestore limit (model=${this.model})`);
    }

    const doc: StoredDoc = {
      model: this.model,
      payload: JSON.stringify(payload),
    };
    // uid/grantId/userCode は payload から非正規化してトップレベルへ複製する
    // (findByUid/revokeByGrantId/findByUserCode のクエリ用)。
    const { uid, grantId, userCode } = payload as {
      uid?: string;
      grantId?: string;
      userCode?: string;
    };
    if (uid !== undefined) doc.uid = uid;
    if (grantId !== undefined) doc.grantId = grantId;
    if (userCode !== undefined) doc.userCode = userCode;

    // Client 等 TTL 対象外モデルは expiresIn が undefined で来る
    // (node_modules/oidc-provider/lib/helpers/defaults.js の ttl マップに
    // Client が存在しないことを確認済み)。その場合 expiresAt を書かない = 自動削除されない。
    if (typeof expiresIn === "number") {
      doc.expiresAt = Timestamp.fromMillis(Date.now() + (expiresIn + EXPIRY_GRACE_SECONDS) * 1000);
    }

    // upsert は常に「完全な新しい payload」で置き換える(oidc-provider既定のMemoryAdapter
    // と同じ挙動)。consumed 等の旧フィールドは新payloadに含まれなければ自然に消える
    // (set()による全置換のため、merge:trueは使わない)。
    await this.collection().doc(docId).set(doc);
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const docId = buildDocId(this.model, id);
    if (isDocIdTooLong(docId)) return undefined;
    const snap = await this.collection().doc(docId).get();
    if (!snap.exists) return undefined;
    const doc = snap.data() as StoredDoc;
    if (isExpired(doc)) return undefined;
    return parsePayload(doc, docId);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findByField("userCode", userCode);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findByField("uid", uid);
  }

  private async findByField(field: "userCode" | "uid", value: string): Promise<AdapterPayload | undefined> {
    const snap = await this.collection().where("model", "==", this.model).where(field, "==", value).limit(1).get();
    if (snap.empty) return undefined;
    const docSnap = snap.docs[0]!;
    const doc = docSnap.data() as StoredDoc;
    if (isExpired(doc)) return undefined;
    return parsePayload(doc, docSnap.id);
  }

  /**
   * この PR の中核: 同一 id への並行 consume() が 1 件のみ成功するよう、Firestore
   * transaction 内で「consumed 未設定なら書き込み、設定済み/不在なら InvalidGrant」を
   * 原子的に行う。oidc-provider は find()→アプリ層のconsumedチェック→consume()の順で
   * 処理するため(node_modules/oidc-provider/lib/helpers/grant_common.js:29-35)、
   * adapter側の原子性保証がないと同一コードから2本のアクセストークンが出うる。
   * InvalidGrant を投げると oidc-provider が 400 invalid_grant にマップし
   * トークンは発行されない(fail closed)。
   *
   * 意図的に isExpired() をチェックしない: 期限切れの妥当性判断は model 層
   * (`base_model.js` の `verify()`)の責務であり、adapter層(このメソッド)の責務ではない
   * (`node_modules/oidc-provider/lib/models/mixins/consumable.js` の `consume()` も
   * `adapter.consume(this.jti)` を素通しするだけで期限チェックをしない、既定実装と同型)。
   * また `findGrantSource`(`grant_common.js`)は再利用検知のため
   * `Model.find(value, { ignoreExpiration: true })` で意図的に期限切れでも検索する経路を
   * 持つ。ここで adapter 側が独自に期限切れを弾くと、この再利用検知の意図を阻害しうる
   * (pr-review-toolkit:pr-test-analyzer指摘の検討結果、2026-08-22)。
   */
  async consume(id: string): Promise<void> {
    const docId = buildDocId(this.model, id);
    await this.db.runTransaction(async (tx) => {
      const ref = this.collection().doc(docId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new errors.InvalidGrant(`${this.model} not found for consume`);
      }
      const doc = snap.data() as StoredDoc;
      if (doc.consumed !== undefined) {
        throw new errors.InvalidGrant(`${this.model} already consumed`);
      }
      tx.update(ref, { consumed: Math.floor(Date.now() / 1000) });
    });
  }

  async destroy(id: string): Promise<void> {
    const docId = buildDocId(this.model, id);
    await this.collection().doc(docId).delete();
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const snap = await this.collection().where("model", "==", this.model).where("grantId", "==", grantId).get();
    await Promise.all(snap.docs.map((docSnap) => docSnap.ref.delete()));
  }
}

export function createFirestoreAdapterFactory(db: Firestore): AdapterFactory {
  return (model: string) => new FirestoreOidcAdapter(db, model);
}
