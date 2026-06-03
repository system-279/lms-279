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

import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";

import type { Course, CourseProgress, User } from "../../types/entities.js";
import type {
  DispatchTenantDataView,
  DispatchTenantInfo,
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
    // enrollment_settings は listProgressReportTargetUsers 内でのみ参照する (既存テスト mock との互換のため lazy 化)
    const db = this.db;

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

      async listProgressReportTargetUsers(
        now: Date,
      ): Promise<Pick<User, "id" | "email" | "name">[]> {
        // Plan A (ADR-039 D-5 簡素化): role=student + videoAccessUntil 期限内 + 進捗 >= 1%
        // 退会・enrollment 存在判定は Firestore schema 不在のためスコープ外。
        //
        // collection 名は **enrollment_setting** (singular) — 既存 prod schema
        // (services/api/src/datasource/firestore.ts:1674、routes/super-admin.ts:1561 等)
        // と一致させる (`enrollment_settings` plural は本層独自の typo であった、
        // /code-review medium で検出)。
        //
        // 1. テナント全体 videoAccessUntil 確認 + 2. student role の user 一覧 を並列実行
        //    (互いに独立した read、Promise.all で 1 RTT 削減)
        const [enrollSnap, userSnap] = await Promise.all([
          db
            .collection(`tenants/${tenantId}/enrollment_setting`)
            .doc("_config")
            .get(),
          usersCol.where("role", "==", "student").get(),
        ]);
        if (enrollSnap.exists) {
          const enrollData = (enrollSnap.data() ?? {}) as Record<string, unknown>;
          const videoAccessUntil = enrollData.videoAccessUntil as
            | string
            | undefined;
          if (
            videoAccessUntil !== undefined &&
            new Date(videoAccessUntil).getTime() <= now.getTime()
          ) {
            return [];
          }
        }
        const users = (userSnap as { docs: QueryDocumentSnapshot[] }).docs.map(
          (d) => {
            const data = d.data() ?? {};
            return {
              id: d.id,
              // 既存 listNotificationTargetUsers と同型の defensive default
              // (email 欠落 student doc を undefined のまま下流に流さない)
              email: (data.email as string) ?? "",
              name: (data.name as string | null) ?? null,
            };
          },
        );
        if (users.length === 0) return [];
        // 3. 進捗 1% 以上 filter
        //    Promise.all で全 user の course_progress query を並列実行 (N+1 sequential を回避)。
        //    Cloud Run 単一インスタンスから Firestore concurrent connection limit (default ~100)
        //    内に収まるよう、user 数は ADR-039 D-7 で <500 名前提。
        const minRatio = DISPATCH_CONSTRAINTS.PROGRESS_REPORT_MIN_PROGRESS_PERCENT / 100;
        const candidates = await Promise.all(
          users.map(async (user) => {
            const progSnap = await progressCol.where("userId", "==", user.id).get();
            const progresses = (progSnap as { docs: QueryDocumentSnapshot[] }).docs;
            if (progresses.length === 0) return null;
            let totalCompleted = 0;
            let totalLessons = 0;
            for (const p of progresses) {
              const pdata = p.data() ?? {};
              totalCompleted += (pdata.completedLessons as number) ?? 0;
              totalLessons += (pdata.totalLessons as number) ?? 0;
            }
            if (totalLessons === 0) return null;
            return totalCompleted / totalLessons >= minRatio ? user : null;
          }),
        );
        return candidates.filter(
          (u): u is Pick<User, "id" | "email" | "name"> => u !== null,
        );
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

  async getTenantInfo(tenantId: string): Promise<DispatchTenantInfo | null> {
    // Phase 3 ADR-039 D-6/D-7: tenants/{tid} doc から status + progressReportEnabled 取得
    const doc = await this.db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    return {
      tenantId,
      // tenant.status === "active" のときのみ true (suspended / 未設定 は false)
      active: (data.status as string | undefined) === "active",
      // progressReportEnabled は default false (opt-in、ADR-039 D-6)
      progressReportEnabled:
        (data.progressReportEnabled as boolean | undefined) ?? false,
    };
  }
}
