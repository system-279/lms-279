/**
 * テスト専用の最小 Firestore フェイク。
 * collection().doc().get()/.set()/.delete()、collection().where().get()、
 * runTransaction(tx.get/set/update/delete) を実 Firestore に近いセマンティクスで
 * サポートする（update は部分マージ。旧実装は誤って全置換していた——
 * pr-review-toolkit 指摘、CLAUDE.md「Partial Update関数のテストに更新対象外
 * フィールドが不変であることを含める」MUST に抵触するリスクだったため修正）。
 * 本番コードからは import しない。
 */
import type { Firestore } from "@google-cloud/firestore";

type WhereOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

interface WhereFilter {
  field: string;
  op: WhereOp;
  value: unknown;
}

function matchesFilter(data: unknown, filter: WhereFilter): boolean {
  const record = data as Record<string, unknown>;
  const actual = record[filter.field];
  switch (filter.op) {
    case "==":
      return actual === filter.value;
    case "!=":
      return actual !== filter.value;
    case "<":
      return (actual as number | string) < (filter.value as number | string);
    case "<=":
      return (actual as number | string) <= (filter.value as number | string);
    case ">":
      return (actual as number | string) > (filter.value as number | string);
    case ">=":
      return (actual as number | string) >= (filter.value as number | string);
    default:
      return false;
  }
}

class FakeDocRef {
  constructor(
    private readonly store: Map<string, unknown>,
    private readonly id: string
  ) {}

  async get() {
    const exists = this.store.has(this.id);
    const data = this.store.get(this.id);
    return { exists, id: this.id, data: () => data };
  }

  async set(value: unknown) {
    this.setSync(value);
  }

  async delete() {
    this.deleteSync();
  }

  setSync(value: unknown) {
    this.store.set(this.id, value);
  }

  mergeSync(value: unknown) {
    const existing = (this.store.get(this.id) as Record<string, unknown> | undefined) ?? {};
    this.store.set(this.id, { ...existing, ...(value as Record<string, unknown>) });
  }

  deleteSync() {
    this.store.delete(this.id);
  }
}

class FakeQuery {
  constructor(
    private readonly store: Map<string, unknown>,
    private readonly filters: WhereFilter[]
  ) {}

  where(field: string, op: WhereOp, value: unknown): FakeQuery {
    return new FakeQuery(this.store, [...this.filters, { field, op, value }]);
  }

  async get() {
    const docs = Array.from(this.store.entries())
      .filter(([, data]) => this.filters.every((f) => matchesFilter(data, f)))
      .map(([id, data]) => ({ id, exists: true, data: () => data }));
    return { docs, empty: docs.length === 0 };
  }
}

class FakeCollectionRef {
  constructor(private readonly store: Map<string, unknown>) {}
  doc(id: string) {
    return new FakeDocRef(this.store, id);
  }
  where(field: string, op: WhereOp, value: unknown): FakeQuery {
    return new FakeQuery(this.store, [{ field, op, value }]);
  }
}

class FakeTransaction {
  async get(docRef: FakeDocRef) {
    return docRef.get();
  }
  set(docRef: FakeDocRef, value: unknown) {
    docRef.setSync(value);
  }
  update(docRef: FakeDocRef, value: unknown) {
    docRef.mergeSync(value);
  }
  delete(docRef: FakeDocRef) {
    docRef.deleteSync();
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
   * 実 Firestore の runTransaction とは異なり真の atomicity・自動リトライは無い
   * （テスト用の逐次実行シミュレーションに留まる）。並行性そのものの検証は対象外
   * （ADR-042「既知の限界」参照）。read→write の順序・部分マージのセマンティクス
   * 自体は実 Firestore に近づけてあるため、FirestoreDedupStore の分岐ロジック
   * （rollback / markFlushed / decide の書き込み内容）はこのフェイクで検証できる。
   */
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx = new FakeTransaction();
    return fn(tx);
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}
