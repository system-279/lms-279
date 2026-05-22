/**
 * TenantDataLoader の Firestore 実装。
 *
 * 設計仕様書 §3.3 (並列度)、FR-3 (全テナント直列走査)、§4.1.2 (tenant 拡張) 対応。
 *
 * Phase 7 で wiring され、production では本実装、test では InMemoryTenantDataLoader を
 * 切り替えて使用する (factory pattern、`route/internal/dispatch.ts` で DI)。
 *
 * 責務:
 *   - tenants collection の全 ID 列挙 (deterministic sorted order)
 *   - tenant 単位の completionNotificationEnabled / ownerEmail / notificationCcEmails 取得
 *   - tenant 単位の published コース・通知対象ユーザー・進捗の read-only view 提供
 *
 * 非責務:
 *   - tenant の create / delete (本 loader は read-only)
 *   - super_dispatch_settings 取得 (DispatchStorage の責務)
 *   - GCS / Drive / Gmail との連携 (各 service の責務)
 *
 * 設計判断:
 *   - listAllTenantIds は `db.collection("tenants").listDocuments()` ではなく
 *     `.get()` を使う (ID + doc 存在確認の両方を行うため。空 doc も拾う場合は
 *     listDocuments の検討余地あり)
 *   - completionNotificationEnabled 未設定 → default `true` で扱う (既存テナント後方互換、
 *     §4.1.2 「default true」に合致)
 *   - getTenantDataView はクエリを発行するだけで FirestoreDataSource をネストしない
 *     (DataSource は datasource-rule で tenant scoped に bind されているため独立保持)
 */

import type {
  Firestore,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import type { Course, CourseProgress, User } from "../../types/entities.js";
import type {
  DispatchTenantDataView,
  TenantCcConfigView,
  TenantDataLoader,
} from "./tenant-data-loader.js";

// ============================================================
// FirestoreTenantDataLoader
// ============================================================

export class FirestoreTenantDataLoader implements TenantDataLoader {
  constructor(private readonly db: Firestore) {}

  async listAllTenantIds(): Promise<string[]> {
    const snap = await this.db.collection("tenants").get();
    const ids = (snap as { docs: QueryDocumentSnapshot[] }).docs.map((d) => d.id);
    // deterministic order (テストの安定化 + audit の予測可能性)
    return ids.sort();
  }

  getTenantDataView(tenantId: string): DispatchTenantDataView {
    const coursesCol = this.db.collection(`tenants/${tenantId}/courses`);
    const usersCol = this.db.collection(`tenants/${tenantId}/users`);
    const progressCol = this.db.collection(`tenants/${tenantId}/course_progress`);

    return {
      async listPublishedCourses(): Promise<Pick<Course, "id" | "lessonOrder">[]> {
        const snap = await coursesCol.where("status", "==", "published").get();
        return (snap as { docs: QueryDocumentSnapshot[] }).docs.map((d) => {
          const data = d.data() ?? {};
          return {
            id: d.id,
            lessonOrder: (data.lessonOrder as string[]) ?? [],
          };
        });
      },

      async listNotificationTargetUsers(): Promise<
        Pick<User, "id" | "email" | "name">[]
      > {
        // role=student のみを通知対象 (admin / instructor は除外)
        const snap = await usersCol.where("role", "==", "student").get();
        return (snap as { docs: QueryDocumentSnapshot[] }).docs.map((d) => {
          const data = d.data() ?? {};
          return {
            id: d.id,
            email: (data.email as string) ?? "",
            name: (data.name as string | null) ?? null,
          };
        });
      },

      async listCourseProgressForUser(
        userId: string,
      ): Promise<
        Pick<
          CourseProgress,
          "courseId" | "isCompleted" | "totalLessons" | "completedLessons"
        >[]
      > {
        const snap = await progressCol.where("userId", "==", userId).get();
        return (snap as { docs: QueryDocumentSnapshot[] }).docs.map((d) => {
          const data = d.data() ?? {};
          return {
            courseId: (data.courseId as string) ?? "",
            isCompleted: (data.isCompleted as boolean) ?? false,
            totalLessons: (data.totalLessons as number) ?? 0,
            completedLessons: (data.completedLessons as number) ?? 0,
          };
        });
      },
    };
  }

  async getTenantCcConfig(tenantId: string): Promise<TenantCcConfigView | null> {
    const doc = await this.db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    return {
      ownerEmail: (data.ownerEmail as string | null) ?? null,
      notificationCcEmails: (data.notificationCcEmails as string[]) ?? [],
      // §4.1.2: completionNotificationEnabled は default true (既存テナントの後方互換)
      completionNotificationEnabled:
        (data.completionNotificationEnabled as boolean | undefined) ?? true,
    };
  }
}
