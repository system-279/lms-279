/**
 * スーパー管理者向け受講状況管理 レスポンスDTO
 * ソース: services/api/src/routes/super-admin.ts の student-progress エンドポイント
 */

// ============================================================
// GET /super/tenants/:tenantId/student-progress
// ============================================================

export interface SuperStudentProgressResponse {
  tenantId: string;
  tenantName: string;
  students: SuperStudentRecord[];
  totalStudents: number;
}

export interface SuperStudentRecord {
  userId: string;
  userName: string | null;
  userEmail: string;
  courses: SuperCourseRecord[];
}

export interface SuperCourseRecord {
  courseId: string;
  courseName: string;
  completedLessons: number;
  totalLessons: number;
  progressRatio: number;
  isCompleted: boolean;
  lessons: SuperLessonRecord[];
}

export interface SuperLessonRecord {
  lessonId: string;
  lessonTitle: string;
  videoCompleted: boolean;
  quizPassed: boolean;
  quizBestScore: number | null;
  lessonCompleted: boolean;
  latestEntryAt: string | null;
  latestExitAt: string | null;
}
