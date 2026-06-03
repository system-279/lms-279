/**
 * Dispatch 機能用の tenant データ読み取り抽象 layer。
 *
 * 設計仕様書 §3.3 (並列度)、FR-3 (全テナント直列走査)、§4.1 / §4.1.4 関連。
 *
 * 目的:
 *   - run-completion-notifications.ts のメインロジックを DataSource 実装非依存に
 *     する (test では InMemoryTenantDataLoader、production では FirestoreDataSource
 *     ベースの実装を inject)
 *   - tenant 一覧取得 (platform レベル) と tenant 内データ取得 (per-tenant DataSource)
 *     の責務を 1 interface に統合し、orchestration の caller 側 wiring を簡略化
 *
 * 非責務:
 *   - tenant の作成 / 削除 (本 layer は読み取り専用)
 *   - 配信設定 (super_dispatch_settings) の取得 (DispatchStorage の責務)
 *
 * Phase 4 では InMemoryTenantDataLoader のみ実装、Phase 7 で Firestore 実装と
 * production wiring を追加。
 */

import type {
  Course,
  CourseProgress,
  User,
} from "../../types/entities.js";

/**
 * テナント別の通知 CC 設定 (tenants/{tenantId} 拡張フィールドの抜粋)。
 *
 * shared-types の `TenantNotificationCcConfig` と同じ形状だが、本 layer が
 * 必要な field のみに絞った read-only view として独立定義。Phase 5 で
 * spec/shared-types 側に確定したら型統合を検討 (本 Phase ではスコープ外)。
 */
export interface TenantCcConfigView {
  /** テナント単位の通知有効化フラグ (false なら本テナントは配信対象外、AC-7 拡張) */
  completionNotificationEnabled: boolean;
  /** CC に固定で含める owner email (validate 前の raw、null なら CC 追加しない) */
  ownerEmail: string | null;
  /** 追加 CC email 配列 (cc-email-validator で個別検証される、AC-25) */
  notificationCcEmails: string[];
}

/**
 * テナントの基本情報 (Phase 3 ADR-039 D-6 / D-7 反映)。
 *
 * `listProgressReportTargetUsers()` の前段で「tenant が active か」「opt-in 済か」を
 * 確認するために用いる。`run-progress-reports.ts` (PR 3c) でテナント skip 判定に使用。
 */
export interface DispatchTenantInfo {
  tenantId: string;
  /** tenant.status === "active" のときのみ true (suspended は false) */
  active: boolean;
  /**
   * Phase 3 進捗レポート定期自動配信の opt-in フラグ (ADR-039 D-6)。
   * tenant doc の `progressReportEnabled` 欠落時は false (default opt-out)。
   */
  progressReportEnabled: boolean;
}

/**
 * Dispatch 機能向けの tenant 単位 read-only データソース。
 * DataSource interface 全体ではなく、dispatch 機能が必要とする最小 API のみを公開。
 */
export interface DispatchTenantDataView {
  /** published コース一覧 (eligibility 母集合、Critical-2) */
  listPublishedCourses(): Promise<Pick<Course, "id" | "lessonOrder">[]>;
  /** テナント内 user 一覧 (role フィルタは loader 側で実施済) */
  listNotificationTargetUsers(): Promise<
    Pick<User, "id" | "email" | "name">[]
  >;
  /**
   * Phase 3 (ADR-039 D-5 改訂、Plan A 採用):
   * 進捗レポートレーンの送信対象 user 一覧。loader 側で以下のフィルタを全適用済:
   *  - role=student (既存 listNotificationTargetUsers と同じ)
   *  - TenantEnrollmentSetting.videoAccessUntil > now (期限内、`checkVideoAccess` 流用)
   *  - 合計 progressRatio >= PROGRESS_REPORT_MIN_PROGRESS_PERCENT/100 (1% 以上、全コース平均)
   *
   * 本 PR (3a) では「不退会判定」「user-level enrollment 存在判定」を Firestore schema
   * 不在のためフィルタしない (Plan A、ADR-039 D-5 fix-up で簡素化済)。
   *
   * `now` は run-progress-reports.ts の triggeredAt を渡す (テスト時固定可)。
   */
  listProgressReportTargetUsers(
    now: Date,
  ): Promise<Pick<User, "id" | "email" | "name">[]>;
  /** 単一 user の course_progress 一覧 (eligibility 判定入力) */
  listCourseProgressForUser(
    userId: string,
  ): Promise<
    Pick<
      CourseProgress,
      "courseId" | "isCompleted" | "totalLessons" | "completedLessons"
    >[]
  >;
}

/**
 * Platform レベルの tenant 一覧 + テナント単位データの取得を抽象化。
 */
export interface TenantDataLoader {
  /** 全 tenant ID の列挙 (Phase 4 では順序はソート済前提、deterministic) */
  listAllTenantIds(): Promise<string[]>;
  /** テナント単位のデータビュー */
  getTenantDataView(tenantId: string): DispatchTenantDataView;
  /** テナント単位の CC 設定 (null なら通知 disable と同等扱い) */
  getTenantCcConfig(tenantId: string): Promise<TenantCcConfigView | null>;
  /**
   * テナントの基本情報 (Phase 3 ADR-039 D-6/D-7)。
   * 存在しない tenant や doc 欠落時は null を返す。
   */
  getTenantInfo(tenantId: string): Promise<DispatchTenantInfo | null>;
}

// ============================================================
// InMemory 実装 (test / dev 用)
// ============================================================

export interface InMemoryTenantFixture {
  /** publishedCourses は status="published" の判定後の入力 (loader 側 filter 済) */
  publishedCourses: Pick<Course, "id" | "lessonOrder">[];
  /** 通知対象 user (role フィルタ済) */
  users: Pick<User, "id" | "email" | "name">[];
  /** courseProgress (キー: userId、value: progress 配列) */
  courseProgresses: Map<
    string,
    Pick<
      CourseProgress,
      "courseId" | "isCompleted" | "totalLessons" | "completedLessons"
    >[]
  >;
  /** CC 設定 (null なら disable と同等) */
  ccConfig: TenantCcConfigView | null;
  /**
   * Phase 3 ADR-039 D-6/D-7: テナント基本情報。
   * 既存テストの fixture との互換のため optional。未指定時は
   * `{ active: true, progressReportEnabled: false }` と扱う。
   * `listProgressReportTargetUsers` / `getTenantInfo` のみが参照する。
   */
  info?: Omit<DispatchTenantInfo, "tenantId">;
  /**
   * Phase 3 ADR-039 D-5 (Plan A): テナント全体の videoAccessUntil (ISO 8601)。
   * 未指定なら「期限なし」扱い (全 user pass)。`listProgressReportTargetUsers` の
   * 期限フィルタで now と比較する。
   */
  videoAccessUntil?: string;
}

export class InMemoryTenantDataLoader implements TenantDataLoader {
  private fixtures = new Map<string, InMemoryTenantFixture>();
  /** 列挙順序固定 (テストの deterministic 化) */
  private tenantOrder: string[] = [];

  setTenant(tenantId: string, fixture: InMemoryTenantFixture): void {
    if (!this.fixtures.has(tenantId)) {
      this.tenantOrder.push(tenantId);
    }
    this.fixtures.set(tenantId, fixture);
  }

  async listAllTenantIds(): Promise<string[]> {
    return [...this.tenantOrder];
  }

  getTenantDataView(tenantId: string): DispatchTenantDataView {
    const fixture = this.fixtures.get(tenantId);
    if (!fixture) {
      throw new Error(
        `InMemoryTenantDataLoader: unknown tenantId ${tenantId} (test fixture not registered)`,
      );
    }
    return {
      async listPublishedCourses() {
        return fixture.publishedCourses;
      },
      async listNotificationTargetUsers() {
        return fixture.users;
      },
      async listProgressReportTargetUsers(now) {
        // Plan A (ADR-039 D-5): 期限内 + 進捗 >= 1% で filter。
        // 退会・enrollment フィルタは schema 不在のためスコープ外。
        const accessExpired =
          fixture.videoAccessUntil !== undefined &&
          new Date(fixture.videoAccessUntil).getTime() <= now.getTime();
        if (accessExpired) {
          return [];
        }
        const result: Pick<User, "id" | "email" | "name">[] = [];
        for (const user of fixture.users) {
          const progresses = fixture.courseProgresses.get(user.id) ?? [];
          if (progresses.length === 0) continue;
          // 全コース平均 progressRatio = sum(completedLessons)/sum(totalLessons)
          let totalCompleted = 0;
          let totalLessons = 0;
          for (const p of progresses) {
            totalCompleted += p.completedLessons;
            totalLessons += p.totalLessons;
          }
          if (totalLessons === 0) continue;
          const ratio = totalCompleted / totalLessons;
          // PROGRESS_REPORT_MIN_PROGRESS_PERCENT=1 → 0.01 以上
          if (ratio >= 0.01) {
            result.push(user);
          }
        }
        return result;
      },
      async listCourseProgressForUser(userId) {
        return fixture.courseProgresses.get(userId) ?? [];
      },
    };
  }

  async getTenantCcConfig(tenantId: string): Promise<TenantCcConfigView | null> {
    const fixture = this.fixtures.get(tenantId);
    return fixture?.ccConfig ?? null;
  }

  async getTenantInfo(tenantId: string): Promise<DispatchTenantInfo | null> {
    const fixture = this.fixtures.get(tenantId);
    if (!fixture) return null;
    return {
      tenantId,
      active: fixture.info?.active ?? true,
      progressReportEnabled: fixture.info?.progressReportEnabled ?? false,
    };
  }
}
