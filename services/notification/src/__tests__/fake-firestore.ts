/**
 * テスト専用の最小 Firestore フェイク（collection().doc().get()/.set()/.delete()、
 * および runTransaction(tx.get/set/update/delete) のみ）。
 * 本番コードからは import しない。
 */
import type { Firestore } from "@google-cloud/firestore";

class FakeDocRef {
  constructor(
    private readonly store: Map<string, unknown>,
    private readonly id: string
  ) {}

  async get() {
    const exists = this.store.has(this.id);
    const data = this.store.get(this.id);
    return { exists, data: () => data };
  }

  async set(value: unknown) {
    this.store.set(this.id, value);
  }

  async delete() {
    this.store.delete(this.id);
  }
}

class FakeCollectionRef {
  constructor(private readonly store: Map<string, unknown>) {}
  doc(id: string) {
    return new FakeDocRef(this.store, id);
  }
}

class FakeTransaction {
  constructor(private readonly docRef: FakeDocRef) {}
  async get(docRef: FakeDocRef = this.docRef) {
    return docRef.get();
  }
  set(docRef: FakeDocRef, value: unknown) {
    void docRef.set(value);
  }
  update(docRef: FakeDocRef, value: unknown) {
    void docRef.set(value);
  }
  delete(docRef: FakeDocRef) {
    void docRef.delete();
  }
}

export class FakeFirestore {
  private readonly collections = new Map<string, Map<string, unknown>>();

  collection(name: string) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return new FakeCollectionRef(this.collections.get(name)!);
  }

  /**
   * 実 Firestore の runTransaction とは異なり真の atomicity は無い（テスト用の
   * 逐次実行シミュレーションに留まる）。並行性そのものの検証は対象外
   * （FirestoreDedupStore は実 Firestore の transaction プリミティブに委ねる設計、
   * ADR-042 参照）。
   */
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    // updater は特定のdocRefに紐付かないtx.get(docRef)呼び出しに対応するため、
    // ダミーのdocRefでFakeTransactionを構築する（実際には呼び出し側が毎回docRefを渡す）
    const tx = new FakeTransaction(undefined as unknown as FakeDocRef);
    return fn(tx);
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}
