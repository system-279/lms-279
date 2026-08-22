import type { Firestore } from "firebase-admin/firestore";

/**
 * FirestoreOidcAdapter のコントラクトテスト用フェイク。
 * services/api/src/services/dispatch/__tests__/firestore-dispatch-storage.test.ts の
 * buildMockDb() を土台にしつつ、consume() の原子性を検証できるよう
 * 楽観的並行制御(OCC)を追加する: ドキュメントごとに version を持ち、
 * runTransaction のコミット時に読み取った doc の version が変化していれば
 * 競合とみなしてコールバックをリトライする(実 Firestore と同じ挙動)。
 *
 * これが無いと、フェイクの transaction が単に逐次実行されるだけになり、
 * 「並行 consume が 1 件しか成功しない」テストが原子性を証明せず素通りしてしまう
 * (grip資料「AIの自白」item#1、pr-review-toolkitセカンドオピニオンでも指摘)。
 */

interface DocRecord {
  version: number;
  data: Record<string, unknown> | undefined;
}

interface FakeDocRef {
  id: string;
  __path: string;
  __collection: string;
  get(): Promise<FakeDocSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

interface FakeDocSnapshot {
  exists: boolean;
  id: string;
  data(): Record<string, unknown> | undefined;
  ref: FakeDocRef;
}

interface FakeQuerySnapshot {
  empty: boolean;
  docs: FakeDocSnapshot[];
}

type Filter = [field: string, value: unknown];

interface FakeTransaction {
  get(ref: FakeDocRef): Promise<FakeDocSnapshot>;
  set(ref: FakeDocRef, data: Record<string, unknown>): void;
  update(ref: FakeDocRef, data: Record<string, unknown>): void;
  delete(ref: FakeDocRef): void;
}

const MAX_TRANSACTION_ATTEMPTS = 10;

export function createFakeFirestore(): Firestore {
  const store = new Map<string, DocRecord>();

  function getRecord(path: string): DocRecord {
    let rec = store.get(path);
    if (!rec) {
      rec = { version: 0, data: undefined };
      store.set(path, rec);
    }
    return rec;
  }

  function buildDocSnapshot(ref: FakeDocRef, data: Record<string, unknown> | undefined): FakeDocSnapshot {
    return {
      exists: data !== undefined,
      id: ref.id,
      data: () => (data ? { ...data } : undefined),
      ref,
    };
  }

  function buildDocRef(collectionName: string, id: string): FakeDocRef {
    const path = `${collectionName}/${id}`;
    const ref: FakeDocRef = {
      id,
      __path: path,
      __collection: collectionName,
      async get() {
        const rec = getRecord(path);
        return buildDocSnapshot(ref, rec.data);
      },
      async set(data: Record<string, unknown>) {
        const rec = getRecord(path);
        rec.data = { ...data };
        rec.version += 1;
      },
      async update(data: Record<string, unknown>) {
        const rec = getRecord(path);
        if (rec.data === undefined) {
          throw new Error(`fake-firestore: update on non-existent doc ${path}`);
        }
        rec.data = { ...rec.data, ...data };
        rec.version += 1;
      },
      async delete() {
        const rec = getRecord(path);
        rec.data = undefined;
        rec.version += 1;
      },
    };
    return ref;
  }

  function matchesFilters(data: Record<string, unknown>, filters: Filter[]): boolean {
    return filters.every(([field, value]) => data[field] === value);
  }

  function buildQuery(collectionName: string, filters: Filter[], limitCount?: number) {
    return {
      where(field: string, op: string, value: unknown) {
        if (op !== "==") {
          throw new Error(`fake-firestore: unsupported operator "${op}"`);
        }
        return buildQuery(collectionName, [...filters, [field, value]], limitCount);
      },
      limit(n: number) {
        return buildQuery(collectionName, filters, n);
      },
      async get(): Promise<FakeQuerySnapshot> {
        const prefix = `${collectionName}/`;
        const results: FakeDocSnapshot[] = [];
        for (const [path, rec] of store) {
          if (!path.startsWith(prefix)) continue;
          if (rec.data === undefined) continue;
          if (!matchesFilters(rec.data, filters)) continue;
          const id = path.slice(prefix.length);
          results.push(buildDocSnapshot(buildDocRef(collectionName, id), rec.data));
          if (limitCount !== undefined && results.length >= limitCount) break;
        }
        return { empty: results.length === 0, docs: results };
      },
    };
  }

  function buildCollection(name: string) {
    return {
      doc(id: string): FakeDocRef {
        return buildDocRef(name, id);
      },
      where(field: string, op: string, value: unknown) {
        return buildQuery(name, []).where(field, op, value);
      },
    };
  }

  async function runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
      const readVersions = new Map<string, number>();
      const localOverrides = new Map<string, Record<string, unknown> | undefined>();
      const pendingWrites: Array<() => void> = [];

      function ensureReadVersion(path: string): void {
        if (!readVersions.has(path)) {
          readVersions.set(path, getRecord(path).version);
        }
      }

      const tx: FakeTransaction = {
        async get(ref: FakeDocRef) {
          ensureReadVersion(ref.__path);
          const data = localOverrides.has(ref.__path) ? localOverrides.get(ref.__path) : getRecord(ref.__path).data;
          return buildDocSnapshot(ref, data);
        },
        set(ref: FakeDocRef, data: Record<string, unknown>) {
          ensureReadVersion(ref.__path);
          const snapshot = { ...data };
          localOverrides.set(ref.__path, snapshot);
          pendingWrites.push(() => {
            const rec = getRecord(ref.__path);
            rec.data = snapshot;
            rec.version += 1;
          });
        },
        update(ref: FakeDocRef, data: Record<string, unknown>) {
          ensureReadVersion(ref.__path);
          const base = localOverrides.has(ref.__path) ? localOverrides.get(ref.__path) : getRecord(ref.__path).data;
          if (base === undefined) {
            throw new Error(`fake-firestore: tx.update on non-existent doc ${ref.__path}`);
          }
          const merged = { ...base, ...data };
          localOverrides.set(ref.__path, merged);
          pendingWrites.push(() => {
            const rec = getRecord(ref.__path);
            rec.data = merged;
            rec.version += 1;
          });
        },
        delete(ref: FakeDocRef) {
          ensureReadVersion(ref.__path);
          localOverrides.set(ref.__path, undefined);
          pendingWrites.push(() => {
            const rec = getRecord(ref.__path);
            rec.data = undefined;
            rec.version += 1;
          });
        },
      };

      const result = await fn(tx);

      let conflict = false;
      for (const [path, versionAtRead] of readVersions) {
        if (getRecord(path).version !== versionAtRead) {
          conflict = true;
          break;
        }
      }

      if (conflict) {
        continue;
      }

      for (const apply of pendingWrites) apply();
      return result;
    }
    throw new Error("fake-firestore: transaction retry limit exceeded (contention)");
  }

  const db = {
    collection(name: string) {
      return buildCollection(name);
    },
    runTransaction,
  };

  return db as unknown as Firestore;
}
