/**
 * テスト専用の最小 Firestore フェイク（collection().doc().get()/.set() のみ）。
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

export class FakeFirestore {
  private readonly collections = new Map<string, Map<string, unknown>>();

  collection(name: string) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return new FakeCollectionRef(this.collections.get(name)!);
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}
