/**
 * FirestoreDataSource
 * 本番用のFirestoreデータソース実装
 */

import { Firestore, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { logger } from "../utils/logger.js";
import type {
  DataSource,
  CourseFilter,
  LessonFilter,
  NotificationPolicyFilter,
  AuthErrorLogFilter,
  CourseUpdateData,
  LessonUpdateData,
  UserUpdateData,
  NotificationPolicyUpdateData,
} from "./interface.js";
import type {
  Course,
  Lesson,
  User,
  NotificationPolicy,
  AllowedEmail,
  UserSettings,
  AuthErrorLog,
  Video,
  VideoEvent,
  VideoAnalytics,
  VideoFilter,
  VideoEventFilter,
  Quiz,
  QuizAttempt,
  QuizFilter,
  QuizAttemptFilter,
  UserProgress,
  CourseProgress,
  LessonSession,
  TenantEnrollmentSetting,
} from "../types/entities.js";
import { countEffectiveAttempts } from "../services/quiz-attempt-utils.js";

/**
 * @deprecated toISOStrict() または toISOOptional() を使用してください。
 * null/undefined 時に new Date() にフォールバックするため、破損データが正常に見えるリスクがあります。
 */
export function toDate(timestamp: Timestamp | Date | string | null | undefined): Date {
  if (!timestamp) {
    console.warn("toDate(): null/undefined timestamp, returning current time (deprecated behavior)");
    return new Date();
  }
  if (typeof timestamp === "string") return new Date(timestamp);
  if (timestamp instanceof Date) return timestamp;
  if (typeof timestamp.toDate === "function") return timestamp.toDate();
  return new Date();
}

/**
 * 必須フィールド用: ISO 8601 文字列を返す。null/undefinedはエラー。
 */
export function toISOStrict(
  timestamp: Timestamp | Date | string | null | undefined,
  fieldName: string,
): string {
  return toDateStrict(timestamp, fieldName).toISOString();
}

/**
 * 任意フィールド用: null/undefined → null、有効値 → ISO 8601 文字列。
 * lax fallback（現在時刻で埋める）をしない。
 */
export function toISOOptional(
  timestamp: Timestamp | Date | string | null | undefined,
): string | null {
  if (!timestamp) return null;
  if (typeof timestamp === "string") {
    const d = new Date(timestamp);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (timestamp instanceof Date) {
    return isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
  }
  if (typeof timestamp.toDate === "function") {
    const d = timestamp.toDate();
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * 必須フィールド用の厳密な日付パース関数
 * null/undefined/空文字列 → エラーをスロー
 * 無効な日付形式 → エラーをスロー
 * 用途: enrolledAt, quizAccessUntil, videoAccessUntil など、必須の期限フィールド
 */
export function toDateStrict(
  timestamp: Timestamp | Date | string | null | undefined,
  fieldName: string
): Date {
  if (!timestamp || (typeof timestamp === "string" && !timestamp.trim())) {
    throw new Error(
      `Invalid deadline field: ${fieldName} is empty or null. This is a critical data corruption issue.`
    );
  }

  if (typeof timestamp === "string") {
    const parsed = new Date(timestamp);
    if (isNaN(parsed.getTime())) {
      throw new Error(
        `Invalid date format for ${fieldName}: "${timestamp}". Expected ISO 8601 format.`
      );
    }
    return parsed;
  }

  if (timestamp instanceof Date) {
    if (isNaN(timestamp.getTime())) {
      throw new Error(`Invalid Date object for ${fieldName}`);
    }
    return timestamp;
  }

  if (typeof timestamp.toDate === "function") {
    const d = timestamp.toDate();
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid Timestamp.toDate() result for ${fieldName}`);
    }
    return d;
  }

  throw new Error(
    `Unknown timestamp type for ${fieldName}: expected Timestamp|Date|string, got ${typeof timestamp}`
  );
}

/**
 * リスト取得の耐障害マッパー。
 * 1件の破損データで全件が返却不能になることを防ぐ。
 * 変換に失敗したドキュメントはスキップし、エラーログに記録する。
 */
function mapDocsResilient<T>(
  docs: QueryDocumentSnapshot[],
  mapper: (id: string, data: FirebaseFirestore.DocumentData) => T,
  entityName: string,
): T[] {
  const results: T[] = [];
  for (const doc of docs) {
    try {
      results.push(mapper(doc.id, doc.data()));
    } catch (e) {
      logger.error(`Skipping corrupt ${entityName} document ${doc.id}`, { error: e });
    }
  }
  return results;
}

/**
 * Firestoreドキュメントを部分更新するヘルパー
 * FieldValue.serverTimestamp() / Timestamp.now() はSDKバージョン不整合で
 * シリアライズエラーを起こすため、new Date() を使用する。
 * FirestoreはDateをTimestampに自動変換する。
 */
function applyUpdate(docRef: FirebaseFirestore.DocumentReference, data: Record<string, unknown>): Promise<FirebaseFirestore.WriteResult> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) updateFields[key] = value;
  }
  updateFields.updatedAt = new Date();
  return docRef.set(updateFields, { merge: true });
}

export class FirestoreDataSource implements DataSource {
  private db: Firestore;
  private tenantPath: string;
  readonly tenantId: string;

  /**
   * @param db Firestoreインスタンス
   * @param tenantId テナントID（必須）- 空文字列の場合はレガシーモード（ルート直下）
   */
  constructor(db: Firestore, tenantId: string) {
    if (tenantId === undefined || tenantId === null) {
      throw new Error("tenantId is required for FirestoreDataSource");
    }
    this.db = db;
    this.tenantId = tenantId;
    // tenantIdが空文字列の場合はレガシーモード（既存データとの互換性）
    // 空でない場合は tenants/{tenantId}/ プレフィックスを使用
    this.tenantPath = tenantId ? `tenants/${tenantId}/` : "";
  }

  private collection(name: string) {
    return this.db.collection(`${this.tenantPath}${name}`);
  }

  // Courses
  async getCourses(filter?: CourseFilter): Promise<Course[]> {
    let query = this.collection("courses").orderBy("createdAt", "desc");

    if (filter?.status !== undefined) {
      query = query.where("status", "==", filter.status);
    }

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toCourse(id, data), "Course");
  }

  async getCourseById(id: string): Promise<Course | null> {
    const doc = await this.collection("courses").doc(id).get();
    if (!doc.exists) return null;
    return this.toCourse(doc.id, doc.data()!);
  }

  async createCourse(data: Omit<Course, "id" | "createdAt" | "updatedAt">): Promise<Course> {
    const docRef = this.collection("courses").doc();
    const now = new Date();
    await docRef.set({
      ...data,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await docRef.get();
    return this.toCourse(doc.id, doc.data()!);
  }

  async updateCourse(id: string, data: CourseUpdateData): Promise<Course | null> {
    const docRef = this.collection("courses").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toCourse(updated.id, updated.data()!);
  }

  async deleteCourse(id: string): Promise<boolean> {
    const docRef = this.collection("courses").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toCourse(id: string, data: any): Course {
    return {
      id,
      name: data.name,
      description: data.description ?? null,
      status: data.status ?? "draft",
      lessonOrder: data.lessonOrder ?? [],
      passThreshold: data.passThreshold ?? 80,
      createdBy: data.createdBy,
      ...(data.sourceMasterCourseId && { sourceMasterCourseId: data.sourceMasterCourseId }),
      ...(data.copiedAt && { copiedAt: toISOOptional(data.copiedAt) ?? undefined }),
      createdAt: toISOStrict(data.createdAt, "Course.createdAt"),
      updatedAt: toISOStrict(data.updatedAt, "Course.updatedAt"),
    };
  }

  // Lessons
  async getLessons(filter?: LessonFilter): Promise<Lesson[]> {
    let query = this.collection("lessons").orderBy("order", "asc");

    if (filter?.courseId !== undefined) {
      query = query.where("courseId", "==", filter.courseId);
    }

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toLesson(id, data), "Lesson");
  }

  async getLessonById(id: string): Promise<Lesson | null> {
    const doc = await this.collection("lessons").doc(id).get();
    if (!doc.exists) return null;
    return this.toLesson(doc.id, doc.data()!);
  }

  async createLesson(data: Omit<Lesson, "id" | "createdAt" | "updatedAt">): Promise<Lesson> {
    const docRef = this.collection("lessons").doc();
    const now = new Date();
    await docRef.set({
      ...data,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await docRef.get();
    return this.toLesson(doc.id, doc.data()!);
  }

  async updateLesson(id: string, data: LessonUpdateData): Promise<Lesson | null> {
    const docRef = this.collection("lessons").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toLesson(updated.id, updated.data()!);
  }

  async deleteLesson(id: string): Promise<boolean> {
    const docRef = this.collection("lessons").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  async reorderLessons(courseId: string, lessonIds: string[]): Promise<void> {
    const batch = this.db.batch();

    // 各レッスンのorderフィールドをバッチ更新
    lessonIds.forEach((lessonId, index) => {
      const lessonRef = this.collection("lessons").doc(lessonId);
      batch.update(lessonRef, {
        order: index,
        updatedAt: new Date(),
      });
    });

    // コースのlessonOrderも更新
    const courseRef = this.collection("courses").doc(courseId);
    batch.update(courseRef, {
      lessonOrder: lessonIds,
      updatedAt: new Date(),
    });

    await batch.commit();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toLesson(id: string, data: any): Lesson {
    return {
      id,
      courseId: data.courseId,
      title: data.title,
      order: data.order ?? 0,
      hasVideo: data.hasVideo ?? false,
      hasQuiz: data.hasQuiz ?? false,
      videoUnlocksPrior: data.videoUnlocksPrior ?? false,
      createdAt: toISOStrict(data.createdAt, "Lesson.createdAt"),
      updatedAt: toISOStrict(data.updatedAt, "Lesson.updatedAt"),
    };
  }

  // Users
  async getUsers(): Promise<User[]> {
    const snapshot = await this.collection("users").orderBy("createdAt", "desc").get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toUser(id, data), "User");
  }

  async getUserById(id: string): Promise<User | null> {
    const doc = await this.collection("users").doc(id).get();
    if (!doc.exists) return null;
    return this.toUser(doc.id, doc.data()!);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const snapshot = await this.collection("users")
      .where("email", "==", email)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return this.toUser(doc.id, doc.data());
  }

  async getUserByFirebaseUid(uid: string): Promise<User | null> {
    const snapshot = await this.collection("users")
      .where("firebaseUid", "==", uid)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return this.toUser(doc.id, doc.data());
  }

  async createUser(data: Omit<User, "id" | "createdAt" | "updatedAt">): Promise<User> {
    const docRef = this.collection("users").doc();
    const now = new Date();
    await docRef.set({
      ...data,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await docRef.get();
    return this.toUser(doc.id, doc.data()!);
  }

  async updateUser(id: string, data: UserUpdateData): Promise<User | null> {
    const docRef = this.collection("users").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toUser(updated.id, updated.data()!);
  }

  async deleteUser(id: string): Promise<boolean> {
    const docRef = this.collection("users").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toUser(id: string, data: any): User {
    return {
      id,
      email: data.email,
      name: data.name ?? null,
      role: data.role ?? "student",
      firebaseUid: data.firebaseUid,
      createdAt: toISOStrict(data.createdAt, "User.createdAt"),
      updatedAt: toISOStrict(data.updatedAt, "User.updatedAt"),
    };
  }

  // Allowed Emails
  async getAllowedEmails(): Promise<AllowedEmail[]> {
    const snapshot = await this.collection("allowed_emails").orderBy("createdAt", "desc").get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toAllowedEmail(id, data), "AllowedEmail");
  }

  async getAllowedEmailById(id: string): Promise<AllowedEmail | null> {
    const doc = await this.collection("allowed_emails").doc(id).get();
    if (!doc.exists) return null;
    return this.toAllowedEmail(doc.id, doc.data()!);
  }

  async isEmailAllowed(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    const snapshot = await this.collection("allowed_emails")
      .where("email", "==", normalized)
      .limit(1)
      .get();
    return !snapshot.empty;
  }

  async createAllowedEmail(data: Omit<AllowedEmail, "id" | "createdAt">): Promise<AllowedEmail> {
    // 防御的正規化: route 側 `parseEmailInput` に加え datasource 層でも
    // `.trim().toLowerCase()` を徹底し、スクリプト/一括投入/将来の新規 caller 経由
    // でも未正規化レコードが混入しないようにする（ADR-031 必須条件 #3）。
    const docRef = this.collection("allowed_emails").doc();
    await docRef.set({
      ...data,
      email: data.email.trim().toLowerCase(),
      createdAt: new Date(),
    });
    const doc = await docRef.get();
    return this.toAllowedEmail(doc.id, doc.data()!);
  }

  async deleteAllowedEmail(id: string): Promise<boolean> {
    const docRef = this.collection("allowed_emails").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  async deleteAllowedEmailByEmail(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    const snapshot = await this.collection("allowed_emails")
      .where("email", "==", normalized)
      .limit(1)
      .get();
    if (snapshot.empty) return false;
    await snapshot.docs[0].ref.delete();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toAllowedEmail(id: string, data: any): AllowedEmail {
    return {
      id,
      email: data.email,
      note: data.note ?? null,
      createdAt: toISOStrict(data.createdAt, "AllowedEmail.createdAt"),
    };
  }

  // Notification Policies
  async getNotificationPolicies(filter?: NotificationPolicyFilter): Promise<NotificationPolicy[]> {
    let query = this.collection("notification_policies").orderBy("createdAt", "desc");

    if (filter?.scope) {
      query = query.where("scope", "==", filter.scope);
    }
    if (filter?.courseId) {
      query = query.where("courseId", "==", filter.courseId);
    }
    if (filter?.userId) {
      query = query.where("userId", "==", filter.userId);
    }
    if (filter?.active !== undefined) {
      query = query.where("active", "==", filter.active);
    }

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toNotificationPolicy(id, data), "NotificationPolicy");
  }

  async getNotificationPolicyById(id: string): Promise<NotificationPolicy | null> {
    const doc = await this.collection("notification_policies").doc(id).get();
    if (!doc.exists) return null;
    return this.toNotificationPolicy(doc.id, doc.data()!);
  }

  async createNotificationPolicy(
    data: Omit<NotificationPolicy, "id" | "createdAt" | "updatedAt">
  ): Promise<NotificationPolicy> {
    const docRef = this.collection("notification_policies").doc();
    const now = new Date();
    await docRef.set({
      ...data,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await docRef.get();
    return this.toNotificationPolicy(doc.id, doc.data()!);
  }

  async updateNotificationPolicy(
    id: string,
    data: NotificationPolicyUpdateData
  ): Promise<NotificationPolicy | null> {
    const docRef = this.collection("notification_policies").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toNotificationPolicy(updated.id, updated.data()!);
  }

  async deleteNotificationPolicy(id: string): Promise<boolean> {
    const docRef = this.collection("notification_policies").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toNotificationPolicy(id: string, data: any): NotificationPolicy {
    return {
      id,
      scope: data.scope ?? "global",
      courseId: data.courseId ?? null,
      userId: data.userId ?? null,
      firstNotifyAfterMin: data.firstNotifyAfterMin ?? 60,
      repeatIntervalHours: data.repeatIntervalHours ?? 24,
      maxRepeatDays: data.maxRepeatDays ?? 7,
      active: data.active ?? true,
      createdAt: toISOStrict(data.createdAt, "NotificationPolicy.createdAt"),
      updatedAt: toISOStrict(data.updatedAt, "NotificationPolicy.updatedAt"),
    };
  }

  // Auth Error Logs
  async getAuthErrorLogs(filter?: AuthErrorLogFilter): Promise<AuthErrorLog[]> {
    let query = this.collection("auth_error_logs").orderBy("occurredAt", "desc");

    if (filter?.email) {
      query = query.where("email", "==", filter.email);
    }
    if (filter?.startDate) {
      query = query.where("occurredAt", ">=", Timestamp.fromDate(filter.startDate));
    }
    if (filter?.endDate) {
      query = query.where("occurredAt", "<=", Timestamp.fromDate(filter.endDate));
    }

    const limit = filter?.limit ?? 100;
    query = query.limit(limit);

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toAuthErrorLog(id, data), "AuthErrorLog");
  }

  async createAuthErrorLog(data: Omit<AuthErrorLog, "id">): Promise<AuthErrorLog> {
    const docRef = this.collection("auth_error_logs").doc();
    await docRef.set({
      ...data,
      occurredAt: Timestamp.fromDate(new Date(data.occurredAt)),
    });
    const doc = await docRef.get();
    return this.toAuthErrorLog(doc.id, doc.data()!);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toAuthErrorLog(id: string, data: any): AuthErrorLog {
    return {
      id,
      email: data.email,
      tenantId: data.tenantId,
      errorType: data.errorType,
      errorMessage: data.errorMessage,
      path: data.path,
      method: data.method,
      userAgent: data.userAgent ?? null,
      ipAddress: data.ipAddress ?? null,
      occurredAt: toISOStrict(data.occurredAt, "AuthErrorLog.occurredAt"),
    };
  }

  // User Settings
  async getUserSettings(userId: string): Promise<UserSettings | null> {
    const doc = await this.collection("user_settings").doc(userId).get();
    if (!doc.exists) return null;
    return this.toUserSettings(userId, doc.data()!);
  }

  async upsertUserSettings(userId: string, data: Partial<UserSettings>): Promise<UserSettings> {
    const docRef = this.collection("user_settings").doc(userId);
    const doc = await docRef.get();

    if (doc.exists) {
      await applyUpdate(docRef, data as Record<string, unknown>);
    } else {
      await docRef.set({
        notificationEnabled: data.notificationEnabled ?? true,
        timezone: data.timezone ?? "Asia/Tokyo",
        updatedAt: new Date(),
      });
    }

    const updated = await docRef.get();
    return this.toUserSettings(userId, updated.data()!);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toUserSettings(userId: string, data: any): UserSettings {
    return {
      userId,
      notificationEnabled: data.notificationEnabled ?? true,
      timezone: data.timezone ?? "Asia/Tokyo",
      updatedAt: toISOStrict(data.updatedAt, "UserSettings.updatedAt"),
    };
  }

  // Videos
  async getVideos(filter?: VideoFilter): Promise<Video[]> {
    let query = this.collection("videos").orderBy("createdAt", "desc");

    if (filter?.lessonId !== undefined) {
      query = query.where("lessonId", "==", filter.lessonId);
    }
    if (filter?.courseId !== undefined) {
      query = query.where("courseId", "==", filter.courseId);
    }

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toVideo(id, data), "Video");
  }

  async getVideoById(id: string): Promise<Video | null> {
    const doc = await this.collection("videos").doc(id).get();
    if (!doc.exists) return null;
    return this.toVideo(doc.id, doc.data()!);
  }

  async getVideoByLessonId(lessonId: string): Promise<Video | null> {
    const snapshot = await this.collection("videos")
      .where("lessonId", "==", lessonId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return this.toVideo(doc.id, doc.data());
  }

  async createVideo(data: Omit<Video, "id" | "createdAt" | "updatedAt">): Promise<Video> {
    const docRef = this.collection("videos").doc();
    const now = new Date();
    // undefinedフィールドをnullに変換（Firestoreはundefinedを拒否する）
    const sanitized = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v ?? null])
    );
    await docRef.set({
      ...sanitized,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await docRef.get();
    return this.toVideo(doc.id, doc.data()!);
  }

  async updateVideo(
    id: string,
    data: Partial<Pick<Video, "sourceType" | "sourceUrl" | "gcsPath" | "durationSec" | "requiredWatchRatio" | "speedLock" | "driveFileId" | "importStatus" | "importError">>
  ): Promise<Video | null> {
    const docRef = this.collection("videos").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    // undefinedフィールドを除外（buildUpdateData内でundefinedスキップ済み）
    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toVideo(updated.id, updated.data()!);
  }

  async deleteVideo(id: string): Promise<boolean> {
    const docRef = this.collection("videos").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toVideo(id: string, data: any): Video {
    return {
      id,
      lessonId: data.lessonId,
      courseId: data.courseId,
      sourceType: data.sourceType,
      sourceUrl: data.sourceUrl,
      gcsPath: data.gcsPath,
      driveFileId: data.driveFileId,
      importStatus: data.importStatus,
      importError: data.importError,
      durationSec: data.durationSec ?? 0,
      requiredWatchRatio: data.requiredWatchRatio ?? 0.95,
      speedLock: data.speedLock ?? true,
      createdAt: toISOStrict(data.createdAt, "Video.createdAt"),
      updatedAt: toISOStrict(data.updatedAt, "Video.updatedAt"),
    };
  }

  // Video Events
  async createVideoEvents(events: Omit<VideoEvent, "id" | "timestamp">[]): Promise<VideoEvent[]> {
    const batch = this.db.batch();
    const docRefs = events.map(() => this.collection("video_events").doc());
    const now = new Date();

    docRefs.forEach((docRef, index) => {
      const event = events[index];
      batch.set(docRef, {
        ...event,
        seekFrom: event.seekFrom ?? null,
        metadata: event.metadata ?? null,
        timestamp: now,
      });
    });

    await batch.commit();

    const docs = await Promise.all(docRefs.map((ref) => ref.get()));
    return docs.map((doc) => this.toVideoEvent(doc.id, doc.data()!));
  }

  async getVideoEvents(filter: VideoEventFilter): Promise<VideoEvent[]> {
    let query = this.collection("video_events").orderBy("timestamp", "desc");

    if (filter.videoId !== undefined) {
      query = query.where("videoId", "==", filter.videoId);
    }
    if (filter.userId !== undefined) {
      query = query.where("userId", "==", filter.userId);
    }
    if (filter.sessionToken !== undefined) {
      query = query.where("sessionToken", "==", filter.sessionToken);
    }

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toVideoEvent(id, data), "VideoEvent");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toVideoEvent(id: string, data: any): VideoEvent {
    return {
      id,
      videoId: data.videoId,
      userId: data.userId,
      sessionToken: data.sessionToken,
      eventType: data.eventType,
      position: data.position,
      seekFrom: data.seekFrom,
      playbackRate: data.playbackRate,
      timestamp: toISOStrict(data.timestamp, "VideoEvent.timestamp"),
      clientTimestamp: data.clientTimestamp,
      metadata: data.metadata,
    };
  }

  // Video Analytics
  async getVideoAnalytics(userId: string, videoId: string): Promise<VideoAnalytics | null> {
    const docId = `${userId}_${videoId}`;
    const doc = await this.collection("video_analytics").doc(docId).get();
    if (!doc.exists) return null;
    return this.toVideoAnalytics(doc.id, doc.data()!);
  }

  async getVideoAnalyticsByVideoId(videoId: string): Promise<VideoAnalytics[]> {
    const snapshot = await this.collection("video_analytics")
      .where("videoId", "==", videoId)
      .get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toVideoAnalytics(id, data), "VideoAnalytics");
  }

  async getAllVideoAnalytics(): Promise<VideoAnalytics[]> {
    const snapshot = await this.collection("video_analytics").get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toVideoAnalytics(id, data), "VideoAnalytics");
  }

  async upsertVideoAnalytics(
    userId: string,
    videoId: string,
    data: Partial<Omit<VideoAnalytics, "id" | "videoId" | "userId">>
  ): Promise<VideoAnalytics> {
    const docId = `${userId}_${videoId}`;
    const docRef = this.collection("video_analytics").doc(docId);
    const doc = await docRef.get();

    if (doc.exists) {
      await applyUpdate(docRef, data as Record<string, unknown>);
    } else {
      await docRef.set({
        videoId,
        userId,
        watchedRanges: [],
        totalWatchTimeSec: 0,
        coverageRatio: 0,
        isComplete: false,
        seekCount: 0,
        pauseCount: 0,
        totalPauseDurationSec: 0,
        speedViolationCount: 0,
        suspiciousFlags: [],
        ...data,
        updatedAt: new Date(),
      });
    }

    const updated = await docRef.get();
    return this.toVideoAnalytics(docId, updated.data()!);
  }

  async computeAndUpsertVideoAnalytics(
    userId: string, videoId: string,
    compute: (current: VideoAnalytics | null) => Partial<Omit<VideoAnalytics, "id" | "videoId" | "userId">>
  ): Promise<VideoAnalytics> {
    const docId = `${userId}_${videoId}`;
    const docRef = this.collection("video_analytics").doc(docId);

    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      const current = doc.exists ? this.toVideoAnalytics(docId, doc.data()!) : null;
      const update = compute(current);
      const now = new Date();

      if (doc.exists) {
        // undefinedをフィルタリング（Firestoreはundefined値を拒否するため）
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(update)) {
          if (value !== undefined) filtered[key] = value;
        }
        filtered.updatedAt = now;
        tx.set(docRef, filtered, { merge: true });
        return this.toVideoAnalytics(docId, { ...doc.data()!, ...filtered });
      } else {
        const fullData = {
          videoId,
          userId,
          watchedRanges: [],
          totalWatchTimeSec: 0,
          coverageRatio: 0,
          isComplete: false,
          seekCount: 0,
          pauseCount: 0,
          totalPauseDurationSec: 0,
          speedViolationCount: 0,
          suspiciousFlags: [],
          ...update,
          updatedAt: now,
        };
        tx.set(docRef, fullData);
        return this.toVideoAnalytics(docId, fullData);
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toVideoAnalytics(id: string, data: any): VideoAnalytics {
    return {
      id,
      videoId: data.videoId,
      userId: data.userId,
      watchedRanges: data.watchedRanges ?? [],
      totalWatchTimeSec: data.totalWatchTimeSec ?? 0,
      coverageRatio: data.coverageRatio ?? 0,
      isComplete: data.isComplete ?? false,
      seekCount: data.seekCount ?? 0,
      pauseCount: data.pauseCount ?? 0,
      totalPauseDurationSec: data.totalPauseDurationSec ?? 0,
      speedViolationCount: data.speedViolationCount ?? 0,
      suspiciousFlags: data.suspiciousFlags ?? [],
      updatedAt: toISOStrict(data.updatedAt, "VideoAnalytics.updatedAt"),
    };
  }

  // Quizzes
  async getQuizzes(filter?: QuizFilter): Promise<Quiz[]> {
    let query = this.collection("quizzes").orderBy("createdAt", "desc");

    if (filter?.lessonId !== undefined) {
      query = query.where("lessonId", "==", filter.lessonId);
    }
    if (filter?.courseId !== undefined) {
      query = query.where("courseId", "==", filter.courseId);
    }

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toQuiz(id, data), "Quiz");
  }

  async getQuizById(id: string): Promise<Quiz | null> {
    const doc = await this.collection("quizzes").doc(id).get();
    if (!doc.exists) return null;
    return this.toQuiz(doc.id, doc.data()!);
  }

  async getQuizByLessonId(lessonId: string): Promise<Quiz | null> {
    const snapshot = await this.collection("quizzes")
      .where("lessonId", "==", lessonId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return this.toQuiz(doc.id, doc.data());
  }

  async createQuiz(data: Omit<Quiz, "id" | "createdAt" | "updatedAt">): Promise<Quiz> {
    const docRef = this.collection("quizzes").doc();
    const now = new Date();
    await docRef.set({
      ...data,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await docRef.get();
    return this.toQuiz(doc.id, doc.data()!);
  }

  async updateQuiz(
    id: string,
    data: Partial<Omit<Quiz, "id" | "createdAt" | "updatedAt">>
  ): Promise<Quiz | null> {
    const docRef = this.collection("quizzes").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toQuiz(updated.id, updated.data()!);
  }

  async deleteQuiz(id: string): Promise<boolean> {
    const docRef = this.collection("quizzes").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return false;
    await docRef.delete();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toQuiz(id: string, data: any): Quiz {
    return {
      id,
      lessonId: data.lessonId,
      courseId: data.courseId,
      title: data.title,
      passThreshold: data.passThreshold ?? 70,
      maxAttempts: data.maxAttempts ?? 0,
      timeLimitSec: data.timeLimitSec ?? null,
      randomizeQuestions: data.randomizeQuestions ?? false,
      randomizeAnswers: data.randomizeAnswers ?? false,
      requireVideoCompletion: data.requireVideoCompletion ?? true,
      questions: data.questions ?? [],
      createdAt: toISOStrict(data.createdAt, "Quiz.createdAt"),
      updatedAt: toISOStrict(data.updatedAt, "Quiz.updatedAt"),
    };
  }

  // Quiz Attempts
  async getQuizAttempts(filter: QuizAttemptFilter): Promise<QuizAttempt[]> {
    let query = this.collection("quiz_attempts").orderBy("startedAt", "desc");

    if (filter.quizId !== undefined) {
      query = query.where("quizId", "==", filter.quizId);
    }
    if (filter.userId !== undefined) {
      query = query.where("userId", "==", filter.userId);
    }
    if (filter.status !== undefined) {
      query = query.where("status", "==", filter.status);
    }

    const snapshot = await query.get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toQuizAttempt(id, data), "QuizAttempt");
  }

  async getQuizAttemptById(id: string): Promise<QuizAttempt | null> {
    const doc = await this.collection("quiz_attempts").doc(id).get();
    if (!doc.exists) return null;
    return this.toQuizAttempt(doc.id, doc.data()!);
  }

  async createQuizAttempt(data: Omit<QuizAttempt, "id">): Promise<QuizAttempt> {
    const docRef = this.collection("quiz_attempts").doc();
    await docRef.set({ ...data });
    const doc = await docRef.get();
    return this.toQuizAttempt(doc.id, doc.data()!);
  }

  async createQuizAttemptAtomic(
    quizId: string, userId: string, maxAttempts: number, timeLimitSec: number | null,
    data: Omit<QuizAttempt, "id" | "attemptNumber">
  ): Promise<{ attempt: QuizAttempt; existing: boolean } | null> {
    return this.db.runTransaction(async (tx) => {
      // センチネルドキュメントでドキュメントレベルロックを確保
      const lockRef = this.collection("quiz_attempt_locks").doc(`${quizId}_${userId}`);
      await tx.get(lockRef);

      // 全attemptを取得してin_progressチェック + attemptNumber採番
      const snapshot = await tx.get(
        this.collection("quiz_attempts")
          .where("quizId", "==", quizId)
          .where("userId", "==", userId)
          .orderBy("startedAt", "desc")
      );
      const attempts = snapshot.docs.map((doc) => this.toQuizAttempt(doc.id, doc.data()));

      // in_progress チェック（タイムアウト自動クリア含む）
      const inProgress = attempts.find((a) => a.status === "in_progress");
      if (inProgress) {
        const isTimedOut = timeLimitSec && inProgress.startedAt &&
          (Date.now() - new Date(inProgress.startedAt).getTime()) > timeLimitSec * 1000;
        if (isTimedOut) {
          const docRef = this.collection("quiz_attempts").doc(inProgress.id);
          tx.update(docRef, { status: "timed_out", submittedAt: new Date().toISOString() });
        } else {
          return { attempt: inProgress, existing: true };
        }
      }

      // maxAttempts チェック（0は無制限、timed_outは除外）
      if (maxAttempts > 0 && countEffectiveAttempts(attempts) >= maxAttempts) {
        return null;
      }

      const attemptNumber = attempts.length + 1;
      const newDocRef = this.collection("quiz_attempts").doc();
      const attemptData = { ...data, attemptNumber };
      tx.create(newDocRef, attemptData);
      tx.set(lockRef, { quizId, userId, updatedAt: new Date() });

      return {
        attempt: this.toQuizAttempt(newDocRef.id, attemptData),
        existing: false,
      };
    });
  }

  async updateQuizAttempt(
    id: string,
    data: Partial<Omit<QuizAttempt, "id">>
  ): Promise<QuizAttempt | null> {
    const docRef = this.collection("quiz_attempts").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toQuizAttempt(updated.id, updated.data()!);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toQuizAttempt(id: string, data: any): QuizAttempt {
    return {
      id,
      quizId: data.quizId,
      userId: data.userId,
      attemptNumber: data.attemptNumber,
      status: data.status,
      answers: data.answers ?? {},
      score: data.score ?? null,
      isPassed: data.isPassed ?? null,
      startedAt: toISOStrict(data.startedAt, "QuizAttempt.startedAt"),
      submittedAt: toISOOptional(data.submittedAt),
    };
  }

  // User Progress
  async getUserProgress(userId: string, lessonId: string): Promise<UserProgress | null> {
    const docId = `${userId}_${lessonId}`;
    const doc = await this.collection("user_progress").doc(docId).get();
    if (!doc.exists) return null;
    return this.toUserProgress(doc.id, doc.data()!);
  }

  async getUserProgressByCourse(userId: string, courseId: string): Promise<UserProgress[]> {
    const snapshot = await this.collection("user_progress")
      .where("userId", "==", userId)
      .where("courseId", "==", courseId)
      .get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toUserProgress(id, data), "UserProgress");
  }

  async upsertUserProgress(
    userId: string,
    lessonId: string,
    data: Partial<Omit<UserProgress, "id" | "userId" | "lessonId">>
  ): Promise<UserProgress> {
    const docId = `${userId}_${lessonId}`;
    const docRef = this.collection("user_progress").doc(docId);
    const doc = await docRef.get();

    if (doc.exists) {
      await applyUpdate(docRef, data as Record<string, unknown>);
    } else {
      await docRef.set({
        userId,
        lessonId,
        courseId: data.courseId ?? "",
        videoCompleted: data.videoCompleted ?? false,
        quizPassed: data.quizPassed ?? false,
        quizBestScore: data.quizBestScore ?? null,
        lessonCompleted: data.lessonCompleted ?? false,
        ...data,
        updatedAt: new Date(),
      });
    }

    const updated = await docRef.get();
    return this.toUserProgress(docId, updated.data()!);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toUserProgress(id: string, data: any): UserProgress {
    return {
      id,
      userId: data.userId,
      lessonId: data.lessonId,
      courseId: data.courseId,
      videoCompleted: data.videoCompleted ?? false,
      quizPassed: data.quizPassed ?? false,
      quizBestScore: data.quizBestScore ?? null,
      lessonCompleted: data.lessonCompleted ?? false,
      updatedAt: toISOStrict(data.updatedAt, "UserProgress.updatedAt"),
    };
  }

  // Course Progress
  async getCourseProgress(userId: string, courseId: string): Promise<CourseProgress | null> {
    const docId = `${userId}_${courseId}`;
    const doc = await this.collection("course_progress").doc(docId).get();
    if (!doc.exists) return null;
    return this.toCourseProgress(doc.id, doc.data()!);
  }

  async upsertCourseProgress(
    userId: string,
    courseId: string,
    data: Partial<Omit<CourseProgress, "id" | "userId" | "courseId">>
  ): Promise<CourseProgress> {
    const docId = `${userId}_${courseId}`;
    const docRef = this.collection("course_progress").doc(docId);
    const doc = await docRef.get();

    if (doc.exists) {
      await applyUpdate(docRef, data as Record<string, unknown>);
    } else {
      await docRef.set({
        userId,
        courseId,
        completedLessons: data.completedLessons ?? 0,
        totalLessons: data.totalLessons ?? 0,
        progressRatio: data.progressRatio ?? 0,
        isCompleted: data.isCompleted ?? false,
        ...data,
        updatedAt: new Date(),
      });
    }

    const updated = await docRef.get();
    return this.toCourseProgress(docId, updated.data()!);
  }

  async getCourseProgressByUser(userId: string): Promise<CourseProgress[]> {
    const snapshot = await this.collection("course_progress")
      .where("userId", "==", userId)
      .get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toCourseProgress(id, data), "CourseProgress");
  }

  async getCourseProgressByCourseId(courseId: string): Promise<CourseProgress[]> {
    const snapshot = await this.collection("course_progress")
      .where("courseId", "==", courseId)
      .get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toCourseProgress(id, data), "CourseProgress");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toCourseProgress(id: string, data: any): CourseProgress {
    return {
      id,
      userId: data.userId,
      courseId: data.courseId,
      completedLessons: data.completedLessons ?? 0,
      totalLessons: data.totalLessons ?? 0,
      progressRatio: data.progressRatio ?? 0,
      isCompleted: data.isCompleted ?? false,
      updatedAt: toISOStrict(data.updatedAt, "CourseProgress.updatedAt"),
    };
  }

  // ========================================
  // Lesson Sessions
  // ========================================

  async createLessonSession(data: Omit<LessonSession, "id" | "createdAt" | "updatedAt">): Promise<LessonSession> {
    const docRef = this.collection("lesson_sessions").doc();
    const now = new Date();
    const sanitized = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v ?? null])
    );
    await docRef.set({
      ...sanitized,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await docRef.get();
    return this.toLessonSession(doc.id, doc.data()!);
  }

  async getOrCreateLessonSession(
    userId: string, lessonId: string,
    data: Omit<LessonSession, "id" | "createdAt" | "updatedAt">
  ): Promise<{ session: LessonSession; created: boolean }> {
    return this.db.runTransaction(async (tx) => {
      // センチネルドキュメントでドキュメントレベルロックを確保
      // クエリのみのトランザクションでは0件ヒット時にロックが効かないため必須
      const lockRef = this.collection("session_locks").doc(`${userId}_${lessonId}`);
      await tx.get(lockRef);

      const snapshot = await tx.get(
        this.collection("lesson_sessions")
          .where("userId", "==", userId)
          .where("lessonId", "==", lessonId)
          .where("status", "==", "active")
          .limit(1)
      );

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        return { session: this.toLessonSession(doc.id, doc.data()), created: false };
      }

      const newDocRef = this.collection("lesson_sessions").doc();
      const now = new Date();
      const sanitized = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v ?? null])
      );
      tx.create(newDocRef, {
        ...sanitized,
        createdAt: now,
        updatedAt: now,
      });
      // ロックドキュメントを更新してトランザクション競合を検知可能にする
      tx.set(lockRef, { userId, lessonId, updatedAt: now });

      return {
        session: this.toLessonSession(newDocRef.id, {
          ...sanitized,
          createdAt: now,
          updatedAt: now,
        }),
        created: true,
      };
    });
  }

  async getLessonSession(sessionId: string): Promise<LessonSession | null> {
    const doc = await this.collection("lesson_sessions").doc(sessionId).get();
    if (!doc.exists) return null;
    return this.toLessonSession(doc.id, doc.data()!);
  }

  async getActiveLessonSession(userId: string, lessonId: string): Promise<LessonSession | null> {
    const snapshot = await this.collection("lesson_sessions")
      .where("userId", "==", userId)
      .where("lessonId", "==", lessonId)
      .where("status", "==", "active")
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return this.toLessonSession(doc.id, doc.data());
  }

  async updateLessonSession(
    sessionId: string,
    data: Partial<Omit<LessonSession, "id" | "createdAt">>
  ): Promise<LessonSession | null> {
    const docRef = this.collection("lesson_sessions").doc(sessionId);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await applyUpdate(docRef, data as Record<string, unknown>);
    const updated = await docRef.get();
    return this.toLessonSession(updated.id, updated.data()!);
  }

  async getLessonSessionsByCourse(courseId: string): Promise<LessonSession[]> {
    const snapshot = await this.collection("lesson_sessions")
      .where("courseId", "==", courseId)
      .orderBy("entryAt", "desc")
      .get();
    return mapDocsResilient(snapshot.docs, (id, data) => this.toLessonSession(id, data), "LessonSession");
  }

  async resetLessonDataForUser(userId: string, lessonId: string, _courseId: string): Promise<void> {
    // 削除対象ドキュメントを収集
    const docsToDelete: FirebaseFirestore.DocumentReference[] = [];

    // 1. video_analytics + video_events
    const video = await this.getVideoByLessonId(lessonId);
    if (video) {
      const analyticsSnap = await this.collection("video_analytics")
        .where("userId", "==", userId)
        .where("videoId", "==", video.id)
        .get();
      for (const doc of analyticsSnap.docs) {
        docsToDelete.push(doc.ref);
      }

      const eventsSnap = await this.collection("video_events")
        .where("userId", "==", userId)
        .where("videoId", "==", video.id)
        .get();
      for (const doc of eventsSnap.docs) {
        docsToDelete.push(doc.ref);
      }
    }

    // 2. quiz_attempts
    const quiz = await this.getQuizByLessonId(lessonId);
    if (quiz) {
      const attemptsSnap = await this.collection("quiz_attempts")
        .where("userId", "==", userId)
        .where("quizId", "==", quiz.id)
        .get();
      for (const doc of attemptsSnap.docs) {
        docsToDelete.push(doc.ref);
      }
    }

    // 3. user_progress
    const progressSnap = await this.collection("user_progress")
      .where("userId", "==", userId)
      .where("lessonId", "==", lessonId)
      .get();
    for (const doc of progressSnap.docs) {
      docsToDelete.push(doc.ref);
    }

    // 500件ずつバッチに分割して削除（Firestore上限対応）
    // リトライ付き: 既に削除済みのドキュメントへのdelete()はno-opなのでリトライ安全
    const BATCH_LIMIT = 500;
    const MAX_RETRIES = 3;
    for (let i = 0; i < docsToDelete.length; i += BATCH_LIMIT) {
      const chunk = docsToDelete.slice(i, i + BATCH_LIMIT);
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const batch = this.db.batch();
          for (const ref of chunk) {
            batch.delete(ref);
          }
          await batch.commit();
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          console.error(
            `resetLessonDataForUser batch ${Math.floor(i / BATCH_LIMIT) + 1} ` +
            `attempt ${attempt + 1}/${MAX_RETRIES} failed:`, err
          );
          if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
          }
        }
      }
      if (lastError) {
        throw new Error(
          `resetLessonDataForUser: batch deletion failed after ${MAX_RETRIES} retries. ` +
          `${i} of ${docsToDelete.length} docs were already deleted.`,
          { cause: lastError }
        );
      }
    }
  }

  // Tenant Enrollment Setting (テナント単位の受講期間管理)

  async getTenantEnrollmentSetting(): Promise<TenantEnrollmentSetting | null> {
    const doc = await this.collection("enrollment_setting").doc("_config").get();
    if (!doc.exists) return null;
    return this.toTenantEnrollmentSetting(doc.id, doc.data()!);
  }

  async upsertTenantEnrollmentSetting(data: Omit<TenantEnrollmentSetting, "id" | "updatedAt">): Promise<TenantEnrollmentSetting> {
    const docRef = this.collection("enrollment_setting").doc("_config");
    await docRef.set({ ...data, updatedAt: new Date() }, { merge: true });
    const updated = await docRef.get();
    return this.toTenantEnrollmentSetting(updated.id, updated.data()!);
  }

  async deleteTenantEnrollmentSetting(): Promise<void> {
    await this.collection("enrollment_setting").doc("_config").delete();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toTenantEnrollmentSetting(id: string, data: any): TenantEnrollmentSetting {
    try {
      return {
        id,
        enrolledAt: toDateStrict(data.enrolledAt, "enrolledAt").toISOString(),
        quizAccessUntil: toDateStrict(data.quizAccessUntil, "quizAccessUntil").toISOString(),
        videoAccessUntil: toDateStrict(data.videoAccessUntil, "videoAccessUntil").toISOString(),
        createdBy: data.createdBy,
        updatedAt: toDateStrict(data.updatedAt, "updatedAt").toISOString(),
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`Failed to parse TenantEnrollmentSetting:`, error);
      throw e;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toLessonSession(id: string, data: any): LessonSession {
    return {
      id,
      userId: data.userId,
      lessonId: data.lessonId,
      courseId: data.courseId,
      videoId: data.videoId,
      sessionToken: data.sessionToken,
      status: data.status,
      entryAt: toISOStrict(data.entryAt, "LessonSession.entryAt"),
      exitAt: toISOOptional(data.exitAt),
      exitReason: data.exitReason ?? null,
      deadlineAt: toISOStrict(data.deadlineAt, "LessonSession.deadlineAt"),
      pauseStartedAt: toISOOptional(data.pauseStartedAt),
      longestPauseSec: data.longestPauseSec ?? 0,
      sessionVideoCompleted: data.sessionVideoCompleted ?? false,
      quizAttemptId: data.quizAttemptId ?? null,
      createdAt: toISOStrict(data.createdAt, "LessonSession.createdAt"),
      updatedAt: toISOStrict(data.updatedAt, "LessonSession.updatedAt"),
    };
  }
}
