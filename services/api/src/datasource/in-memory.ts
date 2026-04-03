/**
 * InMemoryDataSource
 * デモモード用のインメモリデータソース実装
 */

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
import { ReadOnlyDataSourceError } from "./interface.js";
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
  Enrollment,
} from "../types/entities.js";

// デモ用初期データ
const initialCourses: Course[] = [
  {
    id: "demo-course-1",
    name: "プログラミング基礎",
    description: "プログラミングの基本概念を学ぶ入門講座",
    status: "published",
    lessonOrder: ["demo-lesson-1", "demo-lesson-2"],
    passThreshold: 80,
    createdBy: "demo-admin",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-course-2",
    name: "Web開発入門",
    description: "HTML/CSS/JavaScriptの基礎",
    status: "published",
    lessonOrder: ["demo-lesson-3"],
    passThreshold: 70,
    createdBy: "demo-admin",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-course-3",
    name: "データサイエンス入門",
    description: "Pythonを使ったデータ分析の基礎",
    status: "draft",
    lessonOrder: [],
    passThreshold: 75,
    createdBy: "demo-admin",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
];

const initialLessons: Lesson[] = [
  {
    id: "demo-lesson-1",
    courseId: "demo-course-1",
    title: "変数とデータ型",
    order: 0,
    hasVideo: true,
    hasQuiz: true,
    videoUnlocksPrior: false,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-lesson-2",
    courseId: "demo-course-1",
    title: "制御フロー",
    order: 1,
    hasVideo: true,
    hasQuiz: false,
    videoUnlocksPrior: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-lesson-3",
    courseId: "demo-course-2",
    title: "HTML基礎",
    order: 0,
    hasVideo: false,
    hasQuiz: true,
    videoUnlocksPrior: false,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
];

const initialUsers: User[] = [
  {
    id: "demo-admin",
    email: "admin@demo.example.com",
    name: "管理者デモ",
    role: "admin",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-teacher",
    email: "teacher@demo.example.com",
    name: "講師デモ",
    role: "teacher",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-student-1",
    email: "student1@demo.example.com",
    name: "受講者A",
    role: "student",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-student-2",
    email: "student2@demo.example.com",
    name: "受講者B",
    role: "student",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
];

const initialNotificationPolicies: NotificationPolicy[] = [
  {
    id: "demo-policy-global",
    scope: "global",
    courseId: null,
    userId: null,
    firstNotifyAfterMin: 60,
    repeatIntervalHours: 24,
    maxRepeatDays: 7,
    active: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
];

const initialAllowedEmails: AllowedEmail[] = [
  {
    id: "demo-allowed-1",
    email: "admin@demo.example.com",
    note: "デモ管理者",
    createdAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-allowed-2",
    email: "teacher@demo.example.com",
    note: "デモ講師",
    createdAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "demo-allowed-3",
    email: "student1@demo.example.com",
    note: "デモ受講者1",
    createdAt: new Date("2024-01-01T00:00:00Z"),
  },
];

export class InMemoryDataSource implements DataSource {
  private static idCounter = 0;
  private static uniqueId(prefix: string): string {
    return `${prefix}-${Date.now()}-${InMemoryDataSource.idCounter++}`;
  }

  private courses: Course[] = [...initialCourses];
  private lessons: Lesson[] = [...initialLessons];
  private users: User[] = [...initialUsers];
  private notificationPolicies: NotificationPolicy[] = [...initialNotificationPolicies];
  private allowedEmails: AllowedEmail[] = [...initialAllowedEmails];
  private userSettings: Map<string, UserSettings> = new Map();
  private videos: Video[] = [];
  private videoEvents: VideoEvent[] = [];
  private videoAnalytics: Map<string, VideoAnalytics> = new Map();
  private quizzes: Quiz[] = [];
  private quizAttempts: QuizAttempt[] = [];

  private userProgress: Map<string, UserProgress> = new Map();
  private courseProgress: Map<string, CourseProgress> = new Map();
  private lessonSessions: LessonSession[] = [];
  private enrollments = new Map<string, Enrollment>();

  private readonly readOnly: boolean;

  constructor(options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? true;

    // デモ用動画シードデータ
    this.videos = [
      {
        id: "demo-video-1",
        lessonId: "demo-lesson-1",
        courseId: "demo-course-1",
        sourceType: "external_url",
        sourceUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        durationSec: 596,
        requiredWatchRatio: 0.95,
        speedLock: true,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "demo-video-2",
        lessonId: "demo-lesson-2",
        courseId: "demo-course-1",
        sourceType: "external_url",
        sourceUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
        durationSec: 653,
        requiredWatchRatio: 0.95,
        speedLock: true,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ];

    // デモ用テストシードデータ
    this.quizzes = [
      {
        id: "demo-quiz-1",
        lessonId: "demo-lesson-1",
        courseId: "demo-course-1",
        title: "変数とデータ型 確認テスト",
        passThreshold: 70,
        maxAttempts: 0,
        timeLimitSec: 300,
        randomizeQuestions: false,
        randomizeAnswers: false,
        requireVideoCompletion: true,
        questions: [
          {
            id: "q1",
            text: "JavaScriptで変数を宣言するキーワードとして正しいものはどれですか？",
            type: "single",
            options: [
              { id: "q1-a", text: "var", isCorrect: false },
              { id: "q1-b", text: "let", isCorrect: true },
              { id: "q1-c", text: "set", isCorrect: false },
              { id: "q1-d", text: "define", isCorrect: false },
            ],
            points: 10,
            explanation: "JavaScriptではlet, const, varで変数を宣言できます。letはブロックスコープの変数宣言に使用されます。",
          },
          {
            id: "q2",
            text: "次のうち、JavaScriptのプリミティブ型として正しいものを全て選んでください。",
            type: "multi",
            options: [
              { id: "q2-a", text: "string", isCorrect: true },
              { id: "q2-b", text: "number", isCorrect: true },
              { id: "q2-c", text: "array", isCorrect: false },
              { id: "q2-d", text: "boolean", isCorrect: true },
            ],
            points: 20,
            explanation: "JavaScriptのプリミティブ型はstring, number, boolean, null, undefined, symbol, bigintの7つです。arrayはオブジェクト型です。",
          },
          {
            id: "q3",
            text: "constで宣言した変数に再代入するとどうなりますか？",
            type: "single",
            options: [
              { id: "q3-a", text: "値が上書きされる", isCorrect: false },
              { id: "q3-b", text: "TypeError が発生する", isCorrect: true },
              { id: "q3-c", text: "undefinedになる", isCorrect: false },
              { id: "q3-d", text: "何も起きない", isCorrect: false },
            ],
            points: 10,
            explanation: "constで宣言した変数は再代入できません。再代入しようとするとTypeErrorが発生します。",
          },
        ],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ];

    // デモ用VideoAnalyticsシードデータ（student1がdemo-video-1を視聴完了）
    this.videoAnalytics.set("demo-student-1_demo-video-1", {
      id: "demo-student-1_demo-video-1",
      videoId: "demo-video-1",
      userId: "demo-student-1",
      watchedRanges: [{ start: 0, end: 566 }],
      totalWatchTimeSec: 566,
      coverageRatio: 0.95,
      isComplete: true,
      seekCount: 2,
      pauseCount: 5,
      totalPauseDurationSec: 30,
      speedViolationCount: 0,
      suspiciousFlags: [],
      updatedAt: "2024-01-15T10:00:00.000Z",
    });
  }

  private throwIfReadOnly(): void {
    if (this.readOnly) {
      throw new ReadOnlyDataSourceError();
    }
  }

  // Courses
  async getCourses(filter?: CourseFilter): Promise<Course[]> {
    let result = [...this.courses];
    if (filter?.status !== undefined) {
      result = result.filter((c) => c.status === filter.status);
    }
    return result;
  }

  async getCourseById(id: string): Promise<Course | null> {
    return this.courses.find((c) => c.id === id) ?? null;
  }

  async createCourse(data: Omit<Course, "id" | "createdAt" | "updatedAt">): Promise<Course> {
    this.throwIfReadOnly();
    const course: Course = {
      ...data,
      id: InMemoryDataSource.uniqueId("course"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.courses.push(course);
    return course;
  }

  async updateCourse(id: string, data: CourseUpdateData): Promise<Course | null> {
    this.throwIfReadOnly();
    const index = this.courses.findIndex((c) => c.id === id);
    if (index === -1) return null;
    this.courses[index] = { ...this.courses[index], ...data, updatedAt: new Date() };
    return this.courses[index];
  }

  async deleteCourse(id: string): Promise<boolean> {
    this.throwIfReadOnly();
    const index = this.courses.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.courses.splice(index, 1);
    return true;
  }

  // Lessons
  async getLessons(filter?: LessonFilter): Promise<Lesson[]> {
    let result = [...this.lessons];
    if (filter?.courseId !== undefined) {
      result = result.filter((l) => l.courseId === filter.courseId);
    }
    // order昇順でソート
    return result.sort((a, b) => a.order - b.order);
  }

  async getLessonById(id: string): Promise<Lesson | null> {
    return this.lessons.find((l) => l.id === id) ?? null;
  }

  async createLesson(data: Omit<Lesson, "id" | "createdAt" | "updatedAt">): Promise<Lesson> {
    this.throwIfReadOnly();
    const lesson: Lesson = {
      ...data,
      id: InMemoryDataSource.uniqueId("lesson"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.lessons.push(lesson);
    return lesson;
  }

  async updateLesson(id: string, data: LessonUpdateData): Promise<Lesson | null> {
    this.throwIfReadOnly();
    const index = this.lessons.findIndex((l) => l.id === id);
    if (index === -1) return null;
    this.lessons[index] = { ...this.lessons[index], ...data, updatedAt: new Date() };
    return this.lessons[index];
  }

  async deleteLesson(id: string): Promise<boolean> {
    this.throwIfReadOnly();
    const index = this.lessons.findIndex((l) => l.id === id);
    if (index === -1) return false;
    this.lessons.splice(index, 1);
    return true;
  }

  async reorderLessons(courseId: string, lessonIds: string[]): Promise<void> {
    this.throwIfReadOnly();

    // 各レッスンのorderを更新
    lessonIds.forEach((lessonId, index) => {
      const lessonIndex = this.lessons.findIndex((l) => l.id === lessonId);
      if (lessonIndex !== -1) {
        this.lessons[lessonIndex] = {
          ...this.lessons[lessonIndex],
          order: index,
          updatedAt: new Date(),
        };
      }
    });

    // コースのlessonOrderも更新
    const courseIndex = this.courses.findIndex((c) => c.id === courseId);
    if (courseIndex !== -1) {
      this.courses[courseIndex] = {
        ...this.courses[courseIndex],
        lessonOrder: lessonIds,
        updatedAt: new Date(),
      };
    }
  }

  // Users
  async getUsers(): Promise<User[]> {
    return [...this.users];
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.find((u) => u.id === id) ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.users.find((u) => u.email === email) ?? null;
  }

  async getUserByFirebaseUid(uid: string): Promise<User | null> {
    return this.users.find((u) => u.firebaseUid === uid) ?? null;
  }

  async createUser(data: Omit<User, "id" | "createdAt" | "updatedAt">): Promise<User> {
    this.throwIfReadOnly();
    const user: User = {
      ...data,
      id: InMemoryDataSource.uniqueId("user"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.push(user);
    return user;
  }

  async updateUser(id: string, data: UserUpdateData): Promise<User | null> {
    this.throwIfReadOnly();
    const index = this.users.findIndex((u) => u.id === id);
    if (index === -1) return null;
    this.users[index] = { ...this.users[index], ...data, updatedAt: new Date() };
    return this.users[index];
  }

  async deleteUser(id: string): Promise<boolean> {
    this.throwIfReadOnly();
    const index = this.users.findIndex((u) => u.id === id);
    if (index === -1) return false;
    this.users.splice(index, 1);
    return true;
  }

  // Allowed Emails
  async getAllowedEmails(): Promise<AllowedEmail[]> {
    return [...this.allowedEmails];
  }

  async getAllowedEmailById(id: string): Promise<AllowedEmail | null> {
    return this.allowedEmails.find((e) => e.id === id) ?? null;
  }

  async isEmailAllowed(email: string): Promise<boolean> {
    return this.allowedEmails.some((e) => e.email === email);
  }

  async createAllowedEmail(data: Omit<AllowedEmail, "id" | "createdAt">): Promise<AllowedEmail> {
    this.throwIfReadOnly();
    const allowedEmail: AllowedEmail = {
      ...data,
      id: InMemoryDataSource.uniqueId("allowed"),
      createdAt: new Date(),
    };
    this.allowedEmails.push(allowedEmail);
    return allowedEmail;
  }

  async deleteAllowedEmail(id: string): Promise<boolean> {
    this.throwIfReadOnly();
    const index = this.allowedEmails.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.allowedEmails.splice(index, 1);
    return true;
  }

  // Notification Policies
  async getNotificationPolicies(filter?: NotificationPolicyFilter): Promise<NotificationPolicy[]> {
    let result = [...this.notificationPolicies];
    if (filter?.scope) {
      result = result.filter((p) => p.scope === filter.scope);
    }
    if (filter?.courseId) {
      result = result.filter((p) => p.courseId === filter.courseId);
    }
    if (filter?.userId) {
      result = result.filter((p) => p.userId === filter.userId);
    }
    if (filter?.active !== undefined) {
      result = result.filter((p) => p.active === filter.active);
    }
    return result;
  }

  async getNotificationPolicyById(id: string): Promise<NotificationPolicy | null> {
    return this.notificationPolicies.find((p) => p.id === id) ?? null;
  }

  async createNotificationPolicy(
    data: Omit<NotificationPolicy, "id" | "createdAt" | "updatedAt">
  ): Promise<NotificationPolicy> {
    this.throwIfReadOnly();
    const policy: NotificationPolicy = {
      ...data,
      id: InMemoryDataSource.uniqueId("policy"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.notificationPolicies.push(policy);
    return policy;
  }

  async updateNotificationPolicy(
    id: string,
    data: NotificationPolicyUpdateData
  ): Promise<NotificationPolicy | null> {
    this.throwIfReadOnly();
    const index = this.notificationPolicies.findIndex((p) => p.id === id);
    if (index === -1) return null;
    this.notificationPolicies[index] = {
      ...this.notificationPolicies[index],
      ...data,
      updatedAt: new Date(),
    };
    return this.notificationPolicies[index];
  }

  async deleteNotificationPolicy(id: string): Promise<boolean> {
    this.throwIfReadOnly();
    const index = this.notificationPolicies.findIndex((p) => p.id === id);
    if (index === -1) return false;
    this.notificationPolicies.splice(index, 1);
    return true;
  }

  // Auth Error Logs
  async getAuthErrorLogs(_filter?: AuthErrorLogFilter): Promise<AuthErrorLog[]> {
    // デモモードでは認証エラーログは空
    return [];
  }

  async createAuthErrorLog(data: Omit<AuthErrorLog, "id">): Promise<AuthErrorLog> {
    this.throwIfReadOnly();
    // デモモードでは実際には保存しないが、インターフェースに合わせてオブジェクトを返す
    return {
      ...data,
      id: InMemoryDataSource.uniqueId("auth-error"),
    };
  }

  // User Settings
  async getUserSettings(userId: string): Promise<UserSettings | null> {
    return this.userSettings.get(userId) ?? null;
  }

  async upsertUserSettings(userId: string, data: Partial<UserSettings>): Promise<UserSettings> {
    this.throwIfReadOnly();
    const existing = this.userSettings.get(userId);
    const settings: UserSettings = {
      userId,
      notificationEnabled: data.notificationEnabled ?? existing?.notificationEnabled ?? true,
      timezone: data.timezone ?? existing?.timezone ?? "Asia/Tokyo",
      updatedAt: new Date(),
    };
    this.userSettings.set(userId, settings);
    return settings;
  }

  // Videos
  async getVideos(filter?: VideoFilter): Promise<Video[]> {
    let result = [...this.videos];
    if (filter?.lessonId !== undefined) {
      result = result.filter((v) => v.lessonId === filter.lessonId);
    }
    if (filter?.courseId !== undefined) {
      result = result.filter((v) => v.courseId === filter.courseId);
    }
    return result;
  }

  async getVideoById(id: string): Promise<Video | null> {
    return this.videos.find((v) => v.id === id) ?? null;
  }

  async getVideoByLessonId(lessonId: string): Promise<Video | null> {
    return this.videos.find((v) => v.lessonId === lessonId) ?? null;
  }

  async createVideo(data: Omit<Video, "id" | "createdAt" | "updatedAt">): Promise<Video> {
    this.throwIfReadOnly();
    const now = new Date().toISOString();
    const video: Video = {
      ...data,
      id: InMemoryDataSource.uniqueId("video"),
      createdAt: now,
      updatedAt: now,
    };
    this.videos.push(video);
    return video;
  }

  async updateVideo(
    id: string,
    data: Partial<Pick<Video, "sourceType" | "sourceUrl" | "gcsPath" | "durationSec" | "requiredWatchRatio" | "speedLock" | "driveFileId" | "importStatus" | "importError">>
  ): Promise<Video | null> {
    this.throwIfReadOnly();
    const index = this.videos.findIndex((v) => v.id === id);
    if (index === -1) return null;
    this.videos[index] = { ...this.videos[index], ...data, updatedAt: new Date().toISOString() };
    return this.videos[index];
  }

  async deleteVideo(id: string): Promise<boolean> {
    this.throwIfReadOnly();
    const index = this.videos.findIndex((v) => v.id === id);
    if (index === -1) return false;
    this.videos.splice(index, 1);
    return true;
  }

  // Video Events
  async createVideoEvents(events: Omit<VideoEvent, "id" | "timestamp">[]): Promise<VideoEvent[]> {
    this.throwIfReadOnly();
    const now = new Date().toISOString();
    const created: VideoEvent[] = events.map((event) => ({
      ...event,
      id: InMemoryDataSource.uniqueId("video-event"),
      timestamp: now,
    }));
    this.videoEvents.push(...created);
    return created;
  }

  async getVideoEvents(filter: VideoEventFilter): Promise<VideoEvent[]> {
    let result = [...this.videoEvents];
    if (filter.videoId !== undefined) {
      result = result.filter((e) => e.videoId === filter.videoId);
    }
    if (filter.userId !== undefined) {
      result = result.filter((e) => e.userId === filter.userId);
    }
    if (filter.sessionToken !== undefined) {
      result = result.filter((e) => e.sessionToken === filter.sessionToken);
    }
    return result;
  }

  // Video Analytics
  async getVideoAnalytics(userId: string, videoId: string): Promise<VideoAnalytics | null> {
    const key = `${userId}_${videoId}`;
    return this.videoAnalytics.get(key) ?? null;
  }

  async getVideoAnalyticsByVideoId(videoId: string): Promise<VideoAnalytics[]> {
    const result: VideoAnalytics[] = [];
    for (const analytics of this.videoAnalytics.values()) {
      if (analytics.videoId === videoId) {
        result.push(analytics);
      }
    }
    return result;
  }

  async getAllVideoAnalytics(): Promise<VideoAnalytics[]> {
    return Array.from(this.videoAnalytics.values());
  }

  async upsertVideoAnalytics(
    userId: string,
    videoId: string,
    data: Partial<Omit<VideoAnalytics, "id" | "videoId" | "userId">>
  ): Promise<VideoAnalytics> {
    this.throwIfReadOnly();
    const key = `${userId}_${videoId}`;
    const existing = this.videoAnalytics.get(key);
    const analytics: VideoAnalytics = {
      id: key,
      videoId,
      userId,
      watchedRanges: data.watchedRanges ?? existing?.watchedRanges ?? [],
      totalWatchTimeSec: data.totalWatchTimeSec ?? existing?.totalWatchTimeSec ?? 0,
      coverageRatio: data.coverageRatio ?? existing?.coverageRatio ?? 0,
      isComplete: data.isComplete ?? existing?.isComplete ?? false,
      seekCount: data.seekCount ?? existing?.seekCount ?? 0,
      pauseCount: data.pauseCount ?? existing?.pauseCount ?? 0,
      totalPauseDurationSec: data.totalPauseDurationSec ?? existing?.totalPauseDurationSec ?? 0,
      speedViolationCount: data.speedViolationCount ?? existing?.speedViolationCount ?? 0,
      suspiciousFlags: data.suspiciousFlags ?? existing?.suspiciousFlags ?? [],
      updatedAt: new Date().toISOString(),
    };
    this.videoAnalytics.set(key, analytics);
    return analytics;
  }

  async computeAndUpsertVideoAnalytics(
    userId: string, videoId: string,
    compute: (current: VideoAnalytics | null) => Partial<Omit<VideoAnalytics, "id" | "videoId" | "userId">>
  ): Promise<VideoAnalytics> {
    this.throwIfReadOnly();
    const current = await this.getVideoAnalytics(userId, videoId);
    const update = compute(current);
    return this.upsertVideoAnalytics(userId, videoId, update);
  }

  // Quizzes
  async getQuizzes(filter?: QuizFilter): Promise<Quiz[]> {
    let result = [...this.quizzes];
    if (filter?.lessonId !== undefined) {
      result = result.filter((q) => q.lessonId === filter.lessonId);
    }
    if (filter?.courseId !== undefined) {
      result = result.filter((q) => q.courseId === filter.courseId);
    }
    return result;
  }

  async getQuizById(id: string): Promise<Quiz | null> {
    return this.quizzes.find((q) => q.id === id) ?? null;
  }

  async getQuizByLessonId(lessonId: string): Promise<Quiz | null> {
    return this.quizzes.find((q) => q.lessonId === lessonId) ?? null;
  }

  async createQuiz(data: Omit<Quiz, "id" | "createdAt" | "updatedAt">): Promise<Quiz> {
    this.throwIfReadOnly();
    const now = new Date().toISOString();
    const quiz: Quiz = {
      ...data,
      id: InMemoryDataSource.uniqueId("quiz"),
      createdAt: now,
      updatedAt: now,
    };
    this.quizzes.push(quiz);
    return quiz;
  }

  async updateQuiz(
    id: string,
    data: Partial<Omit<Quiz, "id" | "createdAt" | "updatedAt">>
  ): Promise<Quiz | null> {
    this.throwIfReadOnly();
    const index = this.quizzes.findIndex((q) => q.id === id);
    if (index === -1) return null;
    this.quizzes[index] = {
      ...this.quizzes[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };
    return this.quizzes[index];
  }

  async deleteQuiz(id: string): Promise<boolean> {
    this.throwIfReadOnly();
    const index = this.quizzes.findIndex((q) => q.id === id);
    if (index === -1) return false;
    this.quizzes.splice(index, 1);
    return true;
  }

  // Quiz Attempts
  async getQuizAttempts(filter: QuizAttemptFilter): Promise<QuizAttempt[]> {
    let result = [...this.quizAttempts];
    if (filter.quizId !== undefined) {
      result = result.filter((a) => a.quizId === filter.quizId);
    }
    if (filter.userId !== undefined) {
      result = result.filter((a) => a.userId === filter.userId);
    }
    if (filter.status !== undefined) {
      result = result.filter((a) => a.status === filter.status);
    }
    return result;
  }

  async getQuizAttemptById(id: string): Promise<QuizAttempt | null> {
    return this.quizAttempts.find((a) => a.id === id) ?? null;
  }

  async createQuizAttempt(data: Omit<QuizAttempt, "id">): Promise<QuizAttempt> {
    this.throwIfReadOnly();
    const attempt: QuizAttempt = {
      ...data,
      id: InMemoryDataSource.uniqueId("quiz-attempt"),
    };
    this.quizAttempts.push(attempt);
    return attempt;
  }

  async createQuizAttemptAtomic(
    quizId: string, userId: string, maxAttempts: number, timeLimitSec: number | null,
    data: Omit<QuizAttempt, "id" | "attemptNumber">
  ): Promise<{ attempt: QuizAttempt; existing: boolean } | null> {
    this.throwIfReadOnly();
    const existing = this.quizAttempts.filter((a) => a.quizId === quizId && a.userId === userId);

    const inProgress = existing.find((a) => a.status === "in_progress");
    if (inProgress) {
      const isTimedOut = timeLimitSec && inProgress.startedAt &&
        (Date.now() - new Date(inProgress.startedAt).getTime()) > timeLimitSec * 1000;
      if (isTimedOut) {
        inProgress.status = "timed_out";
        inProgress.submittedAt = new Date().toISOString();
      } else {
        return { attempt: inProgress, existing: true };
      }
    }

    if (maxAttempts > 0 && existing.length >= maxAttempts) {
      return null;
    }

    const attempt: QuizAttempt = {
      ...data,
      attemptNumber: existing.length + 1,
      id: InMemoryDataSource.uniqueId("quiz-attempt"),
    };
    this.quizAttempts.push(attempt);
    return { attempt, existing: false };
  }

  async updateQuizAttempt(
    id: string,
    data: Partial<Omit<QuizAttempt, "id">>
  ): Promise<QuizAttempt | null> {
    this.throwIfReadOnly();
    const index = this.quizAttempts.findIndex((a) => a.id === id);
    if (index === -1) return null;
    this.quizAttempts[index] = { ...this.quizAttempts[index], ...data };
    return this.quizAttempts[index];
  }

  // User Progress
  async getUserProgress(userId: string, lessonId: string): Promise<UserProgress | null> {
    const key = `${userId}_${lessonId}`;
    return this.userProgress.get(key) ?? null;
  }

  async getUserProgressByCourse(userId: string, courseId: string): Promise<UserProgress[]> {
    const result: UserProgress[] = [];
    for (const progress of this.userProgress.values()) {
      if (progress.userId === userId && progress.courseId === courseId) {
        result.push(progress);
      }
    }
    return result;
  }

  async upsertUserProgress(
    userId: string,
    lessonId: string,
    data: Partial<Omit<UserProgress, "id" | "userId" | "lessonId">>
  ): Promise<UserProgress> {
    this.throwIfReadOnly();
    const key = `${userId}_${lessonId}`;
    const existing = this.userProgress.get(key);
    const progress: UserProgress = {
      id: key,
      userId,
      lessonId,
      courseId: data.courseId ?? existing?.courseId ?? "",
      videoCompleted: data.videoCompleted ?? existing?.videoCompleted ?? false,
      quizPassed: data.quizPassed ?? existing?.quizPassed ?? false,
      quizBestScore: data.quizBestScore !== undefined ? data.quizBestScore : (existing?.quizBestScore ?? null),
      lessonCompleted: data.lessonCompleted ?? existing?.lessonCompleted ?? false,
      updatedAt: new Date().toISOString(),
    };
    this.userProgress.set(key, progress);
    return progress;
  }

  // Course Progress
  async getCourseProgress(userId: string, courseId: string): Promise<CourseProgress | null> {
    const key = `${userId}_${courseId}`;
    return this.courseProgress.get(key) ?? null;
  }

  async upsertCourseProgress(
    userId: string,
    courseId: string,
    data: Partial<Omit<CourseProgress, "id" | "userId" | "courseId">>
  ): Promise<CourseProgress> {
    this.throwIfReadOnly();
    const key = `${userId}_${courseId}`;
    const existing = this.courseProgress.get(key);
    const progress: CourseProgress = {
      id: key,
      userId,
      courseId,
      completedLessons: data.completedLessons ?? existing?.completedLessons ?? 0,
      totalLessons: data.totalLessons ?? existing?.totalLessons ?? 0,
      progressRatio: data.progressRatio ?? existing?.progressRatio ?? 0,
      isCompleted: data.isCompleted ?? existing?.isCompleted ?? false,
      updatedAt: new Date().toISOString(),
    };
    this.courseProgress.set(key, progress);
    return progress;
  }

  async getCourseProgressByUser(userId: string): Promise<CourseProgress[]> {
    const result: CourseProgress[] = [];
    for (const progress of this.courseProgress.values()) {
      if (progress.userId === userId) {
        result.push(progress);
      }
    }
    return result;
  }

  async getCourseProgressByCourseId(courseId: string): Promise<CourseProgress[]> {
    const result: CourseProgress[] = [];
    for (const progress of this.courseProgress.values()) {
      if (progress.courseId === courseId) {
        result.push(progress);
      }
    }
    return result;
  }

  // Lesson Sessions
  async createLessonSession(data: Omit<LessonSession, "id" | "createdAt" | "updatedAt">): Promise<LessonSession> {
    this.throwIfReadOnly();
    const now = new Date().toISOString();
    const session: LessonSession = {
      ...data,
      id: InMemoryDataSource.uniqueId("session"),
      createdAt: now,
      updatedAt: now,
    };
    this.lessonSessions.push(session);
    return session;
  }

  async getOrCreateLessonSession(
    userId: string, lessonId: string,
    data: Omit<LessonSession, "id" | "createdAt" | "updatedAt">
  ): Promise<{ session: LessonSession; created: boolean }> {
    this.throwIfReadOnly();
    const existing = await this.getActiveLessonSession(userId, lessonId);
    if (existing) {
      return { session: existing, created: false };
    }
    const session = await this.createLessonSession(data);
    return { session, created: true };
  }

  async getLessonSession(sessionId: string): Promise<LessonSession | null> {
    return this.lessonSessions.find((s) => s.id === sessionId) ?? null;
  }

  async getActiveLessonSession(userId: string, lessonId: string): Promise<LessonSession | null> {
    return this.lessonSessions.find(
      (s) => s.userId === userId && s.lessonId === lessonId && s.status === "active"
    ) ?? null;
  }

  async updateLessonSession(
    sessionId: string,
    data: Partial<Omit<LessonSession, "id" | "createdAt">>
  ): Promise<LessonSession | null> {
    this.throwIfReadOnly();
    const index = this.lessonSessions.findIndex((s) => s.id === sessionId);
    if (index === -1) return null;
    this.lessonSessions[index] = {
      ...this.lessonSessions[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };
    return this.lessonSessions[index];
  }

  async getLessonSessionsByCourse(courseId: string): Promise<LessonSession[]> {
    return this.lessonSessions.filter((s) => s.courseId === courseId);
  }

  async resetLessonDataForUser(userId: string, lessonId: string, _courseId: string): Promise<void> {
    this.throwIfReadOnly();

    // 1. video_analytics: lessonId → videoId → 削除
    const video = await this.getVideoByLessonId(lessonId);
    if (video) {
      const analyticsKey = `${userId}_${video.id}`;
      this.videoAnalytics.delete(analyticsKey);
      // 2. video_events: 該当ユーザー+動画のイベント削除
      this.videoEvents = this.videoEvents.filter(
        (e) => !(e.userId === userId && e.videoId === video.id)
      );
    }

    // 3. quiz_attempts: lessonId → quizId → 削除
    const quiz = await this.getQuizByLessonId(lessonId);
    if (quiz) {
      this.quizAttempts = this.quizAttempts.filter(
        (a) => !(a.userId === userId && a.quizId === quiz.id)
      );
    }

    // 4. user_progress: 削除
    const progressKey = `${userId}_${lessonId}`;
    this.userProgress.delete(progressKey);
  }

  // Enrollments (受講期間管理)

  async getEnrollment(userId: string, courseId: string): Promise<Enrollment | null> {
    const key = `${userId}_${courseId}`;
    return this.enrollments.get(key) ?? null;
  }

  async getEnrollmentsByCourse(courseId: string): Promise<Enrollment[]> {
    return Array.from(this.enrollments.values()).filter((e) => e.courseId === courseId);
  }

  async getEnrollmentsByUser(userId: string): Promise<Enrollment[]> {
    return Array.from(this.enrollments.values()).filter((e) => e.userId === userId);
  }

  async upsertEnrollment(data: Omit<Enrollment, "id" | "updatedAt">): Promise<Enrollment> {
    this.throwIfReadOnly();
    const key = `${data.userId}_${data.courseId}`;
    const enrollment: Enrollment = {
      ...data,
      id: key,
      updatedAt: new Date().toISOString(),
    };
    this.enrollments.set(key, enrollment);
    return enrollment;
  }

  async deleteEnrollment(userId: string, courseId: string): Promise<void> {
    this.throwIfReadOnly();
    const key = `${userId}_${courseId}`;
    this.enrollments.delete(key);
  }
}
