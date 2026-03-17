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
  private courses: Course[] = [...initialCourses];
  private lessons: Lesson[] = [...initialLessons];
  private users: User[] = [...initialUsers];
  private notificationPolicies: NotificationPolicy[] = [...initialNotificationPolicies];
  private allowedEmails: AllowedEmail[] = [...initialAllowedEmails];
  private userSettings: Map<string, UserSettings> = new Map();

  private readonly readOnly: boolean;

  constructor(options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? true;
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
      id: `course-${Date.now()}`,
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
      id: `lesson-${Date.now()}`,
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
      id: `user-${Date.now()}`,
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
      id: `allowed-${Date.now()}`,
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
      id: `policy-${Date.now()}`,
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
      id: `auth-error-${Date.now()}`,
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
}
