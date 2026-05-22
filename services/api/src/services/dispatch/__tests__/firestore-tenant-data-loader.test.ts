/**
 * FirestoreTenantDataLoader の mock-based テスト。
 *
 * 設計仕様書 §3.3 (並列度)、FR-3 (全テナント直列走査)、§4.1.2 (tenant 拡張) 対応。
 *
 * テスト戦略 (ADR-028 踏襲):
 *   - InMemoryTenantDataLoader で行動契約は既に保証済 (Phase 4 で integration test)
 *   - 本テストは Firestore-specific I/O 契約のみ検証する:
 *     - listAllTenantIds が tenants collection から ID を抽出すること
 *     - getTenantCcConfig が tenant doc の completionNotificationEnabled / ownerEmail /
 *       notificationCcEmails を返すこと
 *     - getTenantDataView が tenant scoped FirestoreDataSource をラップして
 *       published courses / 通知対象 users / course_progress を返すこと
 *
 * 並行制御の実 race 検証は不要 (本 loader は read-only)。
 */
import { describe, it, expect, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { FirestoreTenantDataLoader } from "../firestore-tenant-data-loader.js";

interface MockDoc {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown>;
}

/**
 * 簡易 mock: db.collection("tenants").listDocuments() / get() / doc(id).get() を表現。
 */
function buildMockDb() {
  // 各 collection の docs を path key で保持
  const tenants = new Map<string, Record<string, unknown>>();
  const courses = new Map<string, Map<string, Record<string, unknown>>>(); // tenantId -> id -> course
  const users = new Map<string, Map<string, Record<string, unknown>>>(); // tenantId -> id -> user
  const progresses = new Map<
    string,
    Map<string, Record<string, unknown>>
  >(); // tenantId -> progressDocId -> progress

  function makeCollection(path: string) {
    const parts = path.split("/");
    // root "tenants" or "tenants/{tid}/X"
    if (path === "tenants") {
      return {
        async get() {
          return {
            docs: Array.from(tenants.entries()).map(([id, data]) => ({
              id,
              exists: true,
              data: () => data,
            })),
          };
        },
        doc(id: string) {
          const data = tenants.get(id);
          return {
            id,
            async get() {
              return {
                id,
                exists: data !== undefined,
                data: () => data ?? {},
              };
            },
          };
        },
      };
    }
    // tenants/{tid}/{coll}
    if (parts.length === 3 && parts[0] === "tenants") {
      const tenantId = parts[1];
      const coll = parts[2];
      const map =
        coll === "courses"
          ? courses.get(tenantId) ?? new Map()
          : coll === "users"
            ? users.get(tenantId) ?? new Map()
            : coll === "course_progress"
              ? progresses.get(tenantId) ?? new Map()
              : new Map();
      const wheres: [string, string, unknown][] = [];
      const q: Record<string, unknown> = {
        where(field: string, op: string, value: unknown) {
          wheres.push([field, op, value]);
          return q;
        },
        async get() {
          const all = Array.from(map.entries()).map(
            ([id, data]) =>
              ({
                id,
                exists: true,
                data: () => data,
              }) satisfies MockDoc,
          );
          // 簡易 where 評価 (== のみ)
          const filtered = wheres.reduce<MockDoc[]>((acc, [field, op, value]) => {
            if (op !== "==") return acc;
            return acc.filter((d) => (d.data() as Record<string, unknown>)[field] === value);
          }, all);
          return { docs: filtered };
        },
      };
      return q;
    }
    return { async get() { return { docs: [] }; } };
  }

  const db = {
    collection: vi.fn((path: string) => makeCollection(path)),
  } as unknown as Firestore;

  return {
    db,
    seedTenant(tenantId: string, data: Record<string, unknown>) {
      tenants.set(tenantId, data);
    },
    seedCourse(tenantId: string, courseId: string, data: Record<string, unknown>) {
      let m = courses.get(tenantId);
      if (!m) {
        m = new Map();
        courses.set(tenantId, m);
      }
      m.set(courseId, data);
    },
    seedUser(tenantId: string, userId: string, data: Record<string, unknown>) {
      let m = users.get(tenantId);
      if (!m) {
        m = new Map();
        users.set(tenantId, m);
      }
      m.set(userId, data);
    },
    seedCourseProgress(
      tenantId: string,
      docId: string,
      data: Record<string, unknown>,
    ) {
      let m = progresses.get(tenantId);
      if (!m) {
        m = new Map();
        progresses.set(tenantId, m);
      }
      m.set(docId, data);
    },
  };
}

// ============================================================
// listAllTenantIds
// ============================================================

describe("FirestoreTenantDataLoader.listAllTenantIds", () => {
  it("tenants collection の全 ID を sorted で返す (deterministic)", async () => {
    const m = buildMockDb();
    m.seedTenant("c-tenant", {});
    m.seedTenant("a-tenant", {});
    m.seedTenant("b-tenant", {});
    const loader = new FirestoreTenantDataLoader(m.db);
    const ids = await loader.listAllTenantIds();
    expect(ids).toEqual(["a-tenant", "b-tenant", "c-tenant"]);
  });

  it("tenants 不在 → 空配列", async () => {
    const m = buildMockDb();
    const loader = new FirestoreTenantDataLoader(m.db);
    const ids = await loader.listAllTenantIds();
    expect(ids).toEqual([]);
  });
});

// ============================================================
// getTenantCcConfig
// ============================================================

describe("FirestoreTenantDataLoader.getTenantCcConfig", () => {
  it("tenant doc のフィールドから CcConfig を組み立てる", async () => {
    const m = buildMockDb();
    m.seedTenant("tenant-a", {
      ownerEmail: "owner@a.example.com",
      notificationCcEmails: ["cc1@a.example.com", "cc2@a.example.com"],
      completionNotificationEnabled: true,
    });
    const loader = new FirestoreTenantDataLoader(m.db);
    const config = await loader.getTenantCcConfig("tenant-a");
    expect(config).toEqual({
      ownerEmail: "owner@a.example.com",
      notificationCcEmails: ["cc1@a.example.com", "cc2@a.example.com"],
      completionNotificationEnabled: true,
    });
  });

  it("tenant doc 不在 → null", async () => {
    const m = buildMockDb();
    const loader = new FirestoreTenantDataLoader(m.db);
    const config = await loader.getTenantCcConfig("unknown");
    expect(config).toBeNull();
  });

  it("ownerEmail / notificationCcEmails 未定義 → 安全な default", async () => {
    const m = buildMockDb();
    m.seedTenant("tenant-b", {
      // ownerEmail / notificationCcEmails 未設定
      completionNotificationEnabled: false,
    });
    const loader = new FirestoreTenantDataLoader(m.db);
    const config = await loader.getTenantCcConfig("tenant-b");
    expect(config).toEqual({
      ownerEmail: null,
      notificationCcEmails: [],
      completionNotificationEnabled: false,
    });
  });

  it("completionNotificationEnabled 未定義 → default true (既存テナントの後方互換)", async () => {
    const m = buildMockDb();
    m.seedTenant("tenant-c", {
      ownerEmail: "x@example.com",
      notificationCcEmails: [],
    });
    const loader = new FirestoreTenantDataLoader(m.db);
    const config = await loader.getTenantCcConfig("tenant-c");
    expect(config?.completionNotificationEnabled).toBe(true);
  });
});

// ============================================================
// getTenantDataView (listPublishedCourses / listNotificationTargetUsers / listCourseProgressForUser)
// ============================================================

describe("FirestoreTenantDataLoader.getTenantDataView", () => {
  it("listPublishedCourses: status=published のコースのみ返す + lessonOrder 込み", async () => {
    const m = buildMockDb();
    m.seedTenant("tenant-a", {});
    m.seedCourse("tenant-a", "course-1", {
      status: "published",
      lessonOrder: ["lesson-1", "lesson-2"],
    });
    m.seedCourse("tenant-a", "course-2", {
      status: "draft",
      lessonOrder: ["lesson-3"],
    });
    m.seedCourse("tenant-a", "course-3", {
      status: "published",
      lessonOrder: [],
    });
    const loader = new FirestoreTenantDataLoader(m.db);
    const view = loader.getTenantDataView("tenant-a");
    const courses = await view.listPublishedCourses();
    expect(courses).toHaveLength(2);
    expect(courses.map((c) => c.id).sort()).toEqual(["course-1", "course-3"]);
    expect(courses.find((c) => c.id === "course-1")?.lessonOrder).toEqual([
      "lesson-1",
      "lesson-2",
    ]);
  });

  it("listNotificationTargetUsers: role=student のみ、id/email/name を返す", async () => {
    const m = buildMockDb();
    m.seedTenant("tenant-a", {});
    m.seedUser("tenant-a", "user-1", {
      email: "a@example.com",
      name: "Alice",
      role: "student",
    });
    m.seedUser("tenant-a", "user-2", {
      email: "b@example.com",
      name: "Bob",
      role: "admin",
    });
    m.seedUser("tenant-a", "user-3", {
      email: "c@example.com",
      name: "Carol",
      role: "student",
    });
    const loader = new FirestoreTenantDataLoader(m.db);
    const view = loader.getTenantDataView("tenant-a");
    const users = await view.listNotificationTargetUsers();
    expect(users).toHaveLength(2);
    const ids = users.map((u) => u.id).sort();
    expect(ids).toEqual(["user-1", "user-3"]);
    expect(users.find((u) => u.id === "user-1")?.email).toBe("a@example.com");
  });

  it("listCourseProgressForUser: 該当 userId の course_progress のみ返す", async () => {
    const m = buildMockDb();
    m.seedTenant("tenant-a", {});
    m.seedCourseProgress("tenant-a", "doc-1", {
      userId: "user-1",
      courseId: "course-1",
      isCompleted: true,
      totalLessons: 5,
      completedLessons: 5,
    });
    m.seedCourseProgress("tenant-a", "doc-2", {
      userId: "user-1",
      courseId: "course-2",
      isCompleted: false,
      totalLessons: 3,
      completedLessons: 1,
    });
    m.seedCourseProgress("tenant-a", "doc-3", {
      userId: "user-2",
      courseId: "course-1",
      isCompleted: true,
      totalLessons: 5,
      completedLessons: 5,
    });
    const loader = new FirestoreTenantDataLoader(m.db);
    const view = loader.getTenantDataView("tenant-a");
    const progresses = await view.listCourseProgressForUser("user-1");
    expect(progresses).toHaveLength(2);
    expect(progresses.map((p) => p.courseId).sort()).toEqual([
      "course-1",
      "course-2",
    ]);
  });
});
