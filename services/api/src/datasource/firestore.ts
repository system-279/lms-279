/**
 * FirestoreDataSource
 * 本番用のFirestoreデータソース実装
 */

import { Firestore, FieldValue, Timestamp } from "firebase-admin/firestore";
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
} from "../types/entities.js";

// Firestore Timestampを Date に変換
function toDate(timestamp: Timestamp | Date | null | undefined): Date {
  if (!timestamp) return new Date();
  if (timestamp instanceof Date) return timestamp;
  if (typeof timestamp.toDate === "function") return timestamp.toDate();
  return new Date();
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
    return snapshot.docs.map((doc) => this.toCourse(doc.id, doc.data()));
  }

  async getCourseById(id: string): Promise<Course | null> {
    const doc = await this.collection("courses").doc(id).get();
    if (!doc.exists) return null;
    return this.toCourse(doc.id, doc.data()!);
  }

  async createCourse(data: Omit<Course, "id" | "createdAt" | "updatedAt">): Promise<Course> {
    const docRef = this.collection("courses").doc();
    const now = FieldValue.serverTimestamp();
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

    await docRef.update({
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
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
      ...(data.copiedAt && { copiedAt: toDate(data.copiedAt) }),
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt),
    };
  }

  // Lessons
  async getLessons(filter?: LessonFilter): Promise<Lesson[]> {
    let query = this.collection("lessons").orderBy("order", "asc");

    if (filter?.courseId !== undefined) {
      query = query.where("courseId", "==", filter.courseId);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => this.toLesson(doc.id, doc.data()));
  }

  async getLessonById(id: string): Promise<Lesson | null> {
    const doc = await this.collection("lessons").doc(id).get();
    if (!doc.exists) return null;
    return this.toLesson(doc.id, doc.data()!);
  }

  async createLesson(data: Omit<Lesson, "id" | "createdAt" | "updatedAt">): Promise<Lesson> {
    const docRef = this.collection("lessons").doc();
    const now = FieldValue.serverTimestamp();
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

    await docRef.update({
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
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
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    // コースのlessonOrderも更新
    const courseRef = this.collection("courses").doc(courseId);
    batch.update(courseRef, {
      lessonOrder: lessonIds,
      updatedAt: FieldValue.serverTimestamp(),
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
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt),
    };
  }

  // Users
  async getUsers(): Promise<User[]> {
    const snapshot = await this.collection("users").orderBy("createdAt", "desc").get();
    return snapshot.docs.map((doc) => this.toUser(doc.id, doc.data()));
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
    const now = FieldValue.serverTimestamp();
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

    await docRef.update({
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
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
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt),
    };
  }

  // Allowed Emails
  async getAllowedEmails(): Promise<AllowedEmail[]> {
    const snapshot = await this.collection("allowed_emails").orderBy("createdAt", "desc").get();
    return snapshot.docs.map((doc) => this.toAllowedEmail(doc.id, doc.data()));
  }

  async getAllowedEmailById(id: string): Promise<AllowedEmail | null> {
    const doc = await this.collection("allowed_emails").doc(id).get();
    if (!doc.exists) return null;
    return this.toAllowedEmail(doc.id, doc.data()!);
  }

  async isEmailAllowed(email: string): Promise<boolean> {
    const snapshot = await this.collection("allowed_emails")
      .where("email", "==", email)
      .limit(1)
      .get();
    return !snapshot.empty;
  }

  async createAllowedEmail(data: Omit<AllowedEmail, "id" | "createdAt">): Promise<AllowedEmail> {
    const docRef = this.collection("allowed_emails").doc();
    await docRef.set({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toAllowedEmail(id: string, data: any): AllowedEmail {
    return {
      id,
      email: data.email,
      note: data.note ?? null,
      createdAt: toDate(data.createdAt),
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
    return snapshot.docs.map((doc) => this.toNotificationPolicy(doc.id, doc.data()));
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
    const now = FieldValue.serverTimestamp();
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

    await docRef.update({
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
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
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt),
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
    return snapshot.docs.map((doc) => this.toAuthErrorLog(doc.id, doc.data()));
  }

  async createAuthErrorLog(data: Omit<AuthErrorLog, "id">): Promise<AuthErrorLog> {
    const docRef = this.collection("auth_error_logs").doc();
    await docRef.set({
      ...data,
      occurredAt: Timestamp.fromDate(data.occurredAt),
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
      occurredAt: toDate(data.occurredAt),
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
      await docRef.update({
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await docRef.set({
        notificationEnabled: data.notificationEnabled ?? true,
        timezone: data.timezone ?? "Asia/Tokyo",
        updatedAt: FieldValue.serverTimestamp(),
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
      updatedAt: toDate(data.updatedAt),
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
    return snapshot.docs.map((doc) => this.toVideo(doc.id, doc.data()));
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
    const now = FieldValue.serverTimestamp();
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

    // undefinedフィールドを除外（Firestoreはundefinedを拒否する）
    const sanitized = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    );
    await docRef.update({
      ...sanitized,
      updatedAt: FieldValue.serverTimestamp(),
    });
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
      createdAt: toDate(data.createdAt).toISOString(),
      updatedAt: toDate(data.updatedAt).toISOString(),
    };
  }

  // Video Events
  async createVideoEvents(events: Omit<VideoEvent, "id" | "timestamp">[]): Promise<VideoEvent[]> {
    const batch = this.db.batch();
    const docRefs = events.map(() => this.collection("video_events").doc());
    const now = FieldValue.serverTimestamp();

    docRefs.forEach((docRef, index) => {
      batch.set(docRef, {
        ...events[index],
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
    return snapshot.docs.map((doc) => this.toVideoEvent(doc.id, doc.data()));
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
      timestamp: toDate(data.timestamp).toISOString(),
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
    return snapshot.docs.map((doc) => this.toVideoAnalytics(doc.id, doc.data()));
  }

  async getAllVideoAnalytics(): Promise<VideoAnalytics[]> {
    const snapshot = await this.collection("video_analytics").get();
    return snapshot.docs.map((doc) => this.toVideoAnalytics(doc.id, doc.data()));
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
      await docRef.update({
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
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
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const updated = await docRef.get();
    return this.toVideoAnalytics(docId, updated.data()!);
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
      updatedAt: toDate(data.updatedAt).toISOString(),
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
    return snapshot.docs.map((doc) => this.toQuiz(doc.id, doc.data()));
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
    const now = FieldValue.serverTimestamp();
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

    await docRef.update({
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
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
      maxAttempts: data.maxAttempts ?? 3,
      timeLimitSec: data.timeLimitSec ?? null,
      randomizeQuestions: data.randomizeQuestions ?? false,
      randomizeAnswers: data.randomizeAnswers ?? false,
      requireVideoCompletion: data.requireVideoCompletion ?? true,
      questions: data.questions ?? [],
      createdAt: toDate(data.createdAt).toISOString(),
      updatedAt: toDate(data.updatedAt).toISOString(),
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
    return snapshot.docs.map((doc) => this.toQuizAttempt(doc.id, doc.data()));
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

  async updateQuizAttempt(
    id: string,
    data: Partial<Omit<QuizAttempt, "id">>
  ): Promise<QuizAttempt | null> {
    const docRef = this.collection("quiz_attempts").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    await docRef.update({ ...data });
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
      startedAt: data.startedAt instanceof Date
        ? data.startedAt.toISOString()
        : typeof data.startedAt?.toDate === "function"
          ? data.startedAt.toDate().toISOString()
          : data.startedAt,
      submittedAt: data.submittedAt == null
        ? null
        : data.submittedAt instanceof Date
          ? data.submittedAt.toISOString()
          : typeof data.submittedAt?.toDate === "function"
            ? data.submittedAt.toDate().toISOString()
            : data.submittedAt,
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
    return snapshot.docs.map((doc) => this.toUserProgress(doc.id, doc.data()));
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
      await docRef.update({
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
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
        updatedAt: FieldValue.serverTimestamp(),
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
      updatedAt: toDate(data.updatedAt).toISOString(),
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
      await docRef.update({
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await docRef.set({
        userId,
        courseId,
        completedLessons: data.completedLessons ?? 0,
        totalLessons: data.totalLessons ?? 0,
        progressRatio: data.progressRatio ?? 0,
        isCompleted: data.isCompleted ?? false,
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const updated = await docRef.get();
    return this.toCourseProgress(docId, updated.data()!);
  }

  async getCourseProgressByUser(userId: string): Promise<CourseProgress[]> {
    const snapshot = await this.collection("course_progress")
      .where("userId", "==", userId)
      .get();
    return snapshot.docs.map((doc) => this.toCourseProgress(doc.id, doc.data()));
  }

  async getCourseProgressByCourseId(courseId: string): Promise<CourseProgress[]> {
    const snapshot = await this.collection("course_progress")
      .where("courseId", "==", courseId)
      .get();
    return snapshot.docs.map((doc) => this.toCourseProgress(doc.id, doc.data()));
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
      updatedAt: toDate(data.updatedAt).toISOString(),
    };
  }
}
