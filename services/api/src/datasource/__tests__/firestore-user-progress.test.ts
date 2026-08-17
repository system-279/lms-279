/**
 * FirestoreDataSource.upsertUserProgress / toUserProgress の直接テスト
 *
 * toUserProgress() はホワイトリスト方式（明示したフィールドのみを返す）実装のため、
 * UserProgress 型にフィールドを追加しても toUserProgress() 側に書き忘れると、
 * 本番 Firestore から読み出した瞬間に黙って値が消える（InMemoryDataSource を使う
 * テストでは検出できない）。これを防ぐためのフィールドパリティテストを含む。
 */
import { describe, it, expect, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { FirestoreDataSource } from "../firestore.js";
import type { UserProgress } from "../../types/entities.js";

// UserProgress の全キー（id を除く。id は upsert 時に自動採番される）
const ALL_USER_PROGRESS_KEYS: Array<keyof UserProgress> = [
  "id",
  "userId",
  "lessonId",
  "courseId",
  "videoCompleted",
  "quizPassed",
  "quizBestScore",
  "quizSkipped",
  "quizSkippedAt",
  "lessonCompleted",
  "updatedAt",
];

/**
 * dispatch-storage テストと同型の、doc単位の状態を保持する簡易 Firestore モック。
 * 新規doc(exists:false)から set() → get() の往復を再現する。
 * seed を渡すと、upsertUserProgress を経由せず「既にFirestoreに存在するdoc」を
 * 直接シード出来る（本PR以前に作成された、新フィールドを持たないレガシーdocの再現用）。
 */
function buildMockDb(seed?: Record<string, unknown>) {
  const docState = new Map<string, { exists: boolean; data: () => Record<string, unknown> }>();
  if (seed) {
    docState.set("user_progress", { exists: true, data: () => seed });
  }

  const docRef = {
    get: vi.fn(async () => docState.get("user_progress") ?? { exists: false, data: () => ({}) }),
    set: vi.fn(async (data: Record<string, unknown>) => {
      docState.set("user_progress", { exists: true, data: () => data });
    }),
  };
  const collectionMock = vi.fn().mockReturnValue({ doc: vi.fn().mockReturnValue(docRef) });
  const db = { collection: collectionMock } as unknown as Firestore;
  return { db, docRef };
}

describe("FirestoreDataSource.upsertUserProgress / toUserProgress", () => {
  it("新規作成時に quizSkipped/quizSkippedAt を保存し、読み出しでも保持される", async () => {
    const { db } = buildMockDb();
    const ds = new FirestoreDataSource(db, "acme");

    const result = await ds.upsertUserProgress("user-1", "lesson-1", {
      courseId: "course-1",
      videoCompleted: true,
      quizSkipped: true,
      quizSkippedAt: "2026-08-17T00:00:00.000Z",
      lessonCompleted: true,
    });

    expect(result.quizSkipped).toBe(true);
    expect(result.quizSkippedAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("quizSkipped/quizSkippedAt を指定しない新規作成では false/null がデフォルトになる", async () => {
    const { db } = buildMockDb();
    const ds = new FirestoreDataSource(db, "acme");

    const result = await ds.upsertUserProgress("user-1", "lesson-1", {
      courseId: "course-1",
      videoCompleted: true,
    });

    expect(result.quizSkipped).toBe(false);
    expect(result.quizSkippedAt).toBeNull();
  });

  it("フィールドパリティ: UserProgress の全キーが toUserProgress() の戻り値に現れる", async () => {
    const { db } = buildMockDb();
    const ds = new FirestoreDataSource(db, "acme");

    const result = await ds.upsertUserProgress("user-1", "lesson-1", {
      courseId: "course-1",
      videoCompleted: true,
      quizPassed: true,
      quizBestScore: 90,
      quizSkipped: false,
      quizSkippedAt: null,
      lessonCompleted: true,
    });

    for (const key of ALL_USER_PROGRESS_KEYS) {
      expect(result).toHaveProperty(key);
      expect(result[key]).not.toBeUndefined();
    }
  });

  it("本PR以前に作成されたレガシーdoc（quizSkipped/quizSkippedAtキーが存在しない）を読んでも false/null にフォールバックする", async () => {
    const { db } = buildMockDb({
      userId: "user-1",
      lessonId: "lesson-1",
      courseId: "course-1",
      videoCompleted: true,
      quizPassed: true,
      quizBestScore: 90,
      lessonCompleted: true,
      updatedAt: "2026-06-01T00:00:00.000Z",
      // quizSkipped / quizSkippedAt キー自体が存在しない（本PR以前のdoc）
    });
    const ds = new FirestoreDataSource(db, "acme");

    const result = await ds.getUserProgress("user-1", "lesson-1");

    expect(result).not.toBeNull();
    expect(result!.quizPassed).toBe(true);
    expect(result!.quizSkipped).toBe(false);
    expect(result!.quizSkippedAt).toBeNull();
  });
});
