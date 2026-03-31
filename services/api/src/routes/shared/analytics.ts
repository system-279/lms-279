/**
 * 分析APIルーター
 * 管理者向けの分析・統計エンドポイント
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import type {
  CourseProgressResponse,
  UserProgressResponse,
  VideoStatsResponse,
  QuizStatsResponse,
  SuspiciousViewingResponse,
  AdminAttendanceResponse,
} from "@lms-279/shared-types";

const router = Router();

// ============================================================
// 1. コース別進捗分析
// GET /admin/analytics/courses/:courseId/progress
// ============================================================

router.get(
  "/admin/analytics/courses/:courseId/progress",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    const [users, courseProgresses] = await Promise.all([
      ds.getUsers(),
      ds.getCourseProgressByCourseId(courseId),
    ]);
    const students = users.filter((u) => u.role === "student");

    const progressMap = new Map(courseProgresses.map((cp) => [cp.userId, cp]));

    const totalStudents = students.length;
    const completedStudents = students.filter(
      (s) => progressMap.get(s.id)?.isCompleted === true
    ).length;

    const progressRatios = students.map((s) => progressMap.get(s.id)?.progressRatio ?? 0);
    const avgProgressRatio =
      totalStudents > 0
        ? progressRatios.reduce((sum, r) => sum + r, 0) / totalStudents
        : 0;

    const studentList = students.map((student) => {
      const progress = progressMap.get(student.id);
      return {
        userId: student.id,
        userName: student.name,
        email: student.email,
        completedLessons: progress?.completedLessons ?? 0,
        totalLessons: progress?.totalLessons ?? course.lessonOrder.length,
        progressRatio: progress?.progressRatio ?? 0,
        isCompleted: progress?.isCompleted ?? false,
      };
    });

    const response: CourseProgressResponse = {
      course: { id: course.id, name: course.name },
      totalStudents,
      completedStudents,
      avgProgressRatio,
      students: studentList,
    };
    res.json(response);
  }
);

// ============================================================
// 2. ユーザー別進捗分析
// GET /admin/analytics/users/:userId/progress
// ============================================================

router.get(
  "/admin/analytics/users/:userId/progress",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const userId = req.params.userId as string;

    const user = await ds.getUserById(userId);
    if (!user) {
      res.status(404).json({ error: "not_found", message: "User not found" });
      return;
    }

    const courseProgresses = await ds.getCourseProgressByUser(userId);

    const courses = await Promise.all(
      courseProgresses.map(async (cp) => {
        const course = await ds.getCourseById(cp.courseId);
        const lessonProgresses = await ds.getUserProgressByCourse(userId, cp.courseId);

        const lessonProgressList = await Promise.all(
          lessonProgresses.map(async (lp) => {
            const lesson = await ds.getLessonById(lp.lessonId);
            return {
              lessonId: lp.lessonId,
              lessonTitle: lesson?.title ?? null,
              videoCompleted: lp.videoCompleted,
              quizPassed: lp.quizPassed,
              lessonCompleted: lp.lessonCompleted,
            };
          })
        );

        return {
          courseId: cp.courseId,
          courseName: course?.name ?? null,
          completedLessons: cp.completedLessons,
          totalLessons: cp.totalLessons,
          progressRatio: cp.progressRatio,
          isCompleted: cp.isCompleted,
          lessonProgresses: lessonProgressList,
        };
      })
    );

    const response: UserProgressResponse = {
      user: { id: user.id, name: user.name, email: user.email },
      courses,
    };
    res.json(response);
  }
);

// ============================================================
// 3. 動画視聴統計
// GET /admin/analytics/videos/:videoId/stats
// ============================================================

router.get(
  "/admin/analytics/videos/:videoId/stats",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const videoId = req.params.videoId as string;

    const video = await ds.getVideoById(videoId);
    if (!video) {
      res.status(404).json({ error: "not_found", message: "Video not found" });
      return;
    }

    const [users, analyticsForVideo] = await Promise.all([
      ds.getUsers(),
      ds.getVideoAnalyticsByVideoId(videoId),
    ]);
    const studentMap = new Map(
      users.filter((u) => u.role === "student").map((u) => [u.id, u])
    );

    const viewers = analyticsForVideo.filter((a) => studentMap.has(a.userId));

    const totalViewers = viewers.length;
    const completedViewers = viewers.filter((a) => a.isComplete).length;

    const avgCoverageRatio =
      totalViewers > 0
        ? viewers.reduce((sum, a) => sum + a.coverageRatio, 0) / totalViewers
        : 0;

    const avgWatchTimeSec =
      totalViewers > 0
        ? viewers.reduce((sum, a) => sum + a.totalWatchTimeSec, 0) / totalViewers
        : 0;

    const viewerList = viewers.map((analytics) => {
      const student = studentMap.get(analytics.userId)!;
      return {
        userId: student.id,
        userName: student.name,
        coverageRatio: analytics.coverageRatio,
        isComplete: analytics.isComplete,
        seekCount: analytics.seekCount,
        speedViolationCount: analytics.speedViolationCount,
        suspiciousFlags: analytics.suspiciousFlags,
      };
    });

    const response: VideoStatsResponse = {
      video: {
        id: video.id,
        lessonId: video.lessonId,
        durationSec: video.durationSec,
      },
      totalViewers,
      completedViewers,
      avgCoverageRatio,
      avgWatchTimeSec,
      viewers: viewerList,
    };
    res.json(response);
  }
);

// ============================================================
// 4. テスト統計
// GET /admin/analytics/quizzes/:quizId/stats
// ============================================================

router.get(
  "/admin/analytics/quizzes/:quizId/stats",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const quizId = req.params.quizId as string;

    const quiz = await ds.getQuizById(quizId);
    if (!quiz) {
      res.status(404).json({ error: "not_found", message: "Quiz not found" });
      return;
    }

    const attempts = await ds.getQuizAttempts({ quizId });
    const submittedAttempts = attempts.filter((a) => a.status === "submitted");

    const totalAttempts = submittedAttempts.length;
    const uniqueStudentIds = new Set(submittedAttempts.map((a) => a.userId));
    const uniqueStudents = uniqueStudentIds.size;

    const passedAttempts = submittedAttempts.filter(
      (a) => a.isPassed === true
    ).length;
    const passRate = totalAttempts > 0 ? passedAttempts / totalAttempts : 0;

    const scores = submittedAttempts
      .map((a) => a.score)
      .filter((s): s is number => s !== null);
    const avgScore =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

    const users = await ds.getUsers();
    const userMap = new Map(users.map((u) => [u.id, u]));

    const attemptList = submittedAttempts.map((a) => {
      const user = userMap.get(a.userId);
      return {
        userId: a.userId,
        userName: user?.name ?? null,
        attemptNumber: a.attemptNumber,
        score: a.score,
        isPassed: a.isPassed,
        submittedAt: a.submittedAt,
      };
    });

    const response: QuizStatsResponse = {
      quiz: {
        id: quiz.id,
        lessonId: quiz.lessonId,
        title: quiz.title,
        passThreshold: quiz.passThreshold,
      },
      totalAttempts,
      uniqueStudents,
      passRate,
      avgScore,
      attempts: attemptList,
    };
    res.json(response);
  }
);

// ============================================================
// 5. 不審視聴一覧
// GET /admin/analytics/suspicious-viewing
// ============================================================

router.get(
  "/admin/analytics/suspicious-viewing",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;

    const [allAnalytics, videos, users] = await Promise.all([
      ds.getAllVideoAnalytics(),
      ds.getVideos(),
      ds.getUsers(),
    ]);

    const studentMap = new Map(
      users.filter((u) => u.role === "student").map((u) => [u.id, u])
    );
    const videoMap = new Map(videos.map((v) => [v.id, v]));

    const suspiciousList = allAnalytics.filter(
      (a) => a.suspiciousFlags.length > 0 && studentMap.has(a.userId)
    );

    const lessonIds = [
      ...new Set(
        suspiciousList
          .map((a) => videoMap.get(a.videoId)?.lessonId)
          .filter((id): id is string => id !== undefined)
      ),
    ];
    const lessons = await Promise.all(lessonIds.map((id) => ds.getLessonById(id)));
    const lessonMap = new Map(
      lessons.filter((l): l is NonNullable<typeof l> => l !== null).map((l) => [l.id, l])
    );

    const suspiciousViewings = suspiciousList.map((analytics) => {
      const student = studentMap.get(analytics.userId)!;
      const video = videoMap.get(analytics.videoId);
      const lessonTitle = video ? (lessonMap.get(video.lessonId)?.title ?? null) : null;
      return {
        userId: student.id,
        userName: student.name,
        videoId: analytics.videoId,
        lessonTitle,
        coverageRatio: analytics.coverageRatio,
        seekCount: analytics.seekCount,
        speedViolationCount: analytics.speedViolationCount,
        suspiciousFlags: analytics.suspiciousFlags,
        updatedAt: analytics.updatedAt,
      };
    });

    const response: SuspiciousViewingResponse = { suspiciousViewings };
    res.json(response);
  }
);

// ============================================================
// 6. コース進捗CSVエクスポート
// GET /admin/analytics/export/courses/:courseId
// ============================================================

router.get(
  "/admin/analytics/export/courses/:courseId",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    const users = await ds.getUsers();
    const students = users.filter((u) => u.role === "student");

    const studentProgresses = await Promise.all(
      students.map(async (student) => {
        const progress = await ds.getCourseProgress(student.id, courseId);
        return { student, progress };
      })
    );

    const header = "ユーザー名,メール,完了レッスン数,全レッスン数,進捗率,完了状態";
    const rows = studentProgresses.map(({ student, progress }) => {
      const completedLessons = progress?.completedLessons ?? 0;
      const totalLessons = progress?.totalLessons ?? course.lessonOrder.length;
      const progressRatio = progress?.progressRatio ?? 0;
      const isCompleted = progress?.isCompleted ?? false;

      const userName = (student.name ?? "").replace(/,/g, "、");
      const email = student.email.replace(/,/g, "");
      const progressPercent = (progressRatio * 100).toFixed(1) + "%";
      const completedLabel = isCompleted ? "完了" : "未完了";

      return `${userName},${email},${completedLessons},${totalLessons},${progressPercent},${completedLabel}`;
    });

    const csv = [header, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="course-progress-${courseId}.csv"`
    );
    res.send(csv);
  }
);

// ============================================================
// 出席管理ヘルパー
// ============================================================

async function buildAttendanceRecords(
  ds: import("../../datasource/interface.js").DataSource,
  courseId: string
): Promise<import("@lms-279/shared-types").AdminAttendanceRecord[]> {
  const sessions = await ds.getLessonSessionsByCourse(courseId);
  const users = await ds.getUsers();
  const lessons = await ds.getLessons({ courseId });

  const userMap = new Map(users.map((u) => [u.id, u]));
  const lessonMap = new Map(lessons.map((l) => [l.id, l]));

  return sessions.map((s) => {
    const user = userMap.get(s.userId);
    const lesson = lessonMap.get(s.lessonId);
    const durationMs = s.exitAt
      ? new Date(s.exitAt).getTime() - new Date(s.entryAt).getTime()
      : Date.now() - new Date(s.entryAt).getTime();

    return {
      sessionId: s.id,
      userId: s.userId,
      userName: user?.name ?? user?.email ?? s.userId,
      userEmail: user?.email ?? "",
      lessonId: s.lessonId,
      lessonTitle: lesson?.title ?? s.lessonId,
      status: s.status,
      entryAt: s.entryAt,
      exitAt: s.exitAt,
      exitReason: s.exitReason,
      durationMin: Math.round(durationMs / 60000),
    };
  });
}

// ============================================================
// 7. 出席管理
// GET /admin/analytics/attendance/courses/:courseId
// ============================================================

router.get(
  "/admin/analytics/attendance/courses/:courseId",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    const records = await buildAttendanceRecords(ds, courseId);

    const response: AdminAttendanceResponse = {
      courseId,
      courseName: course.name,
      totalSessions: records.length,
      completedSessions: records.filter((r) => r.status === "completed").length,
      forceExitedSessions: records.filter((r) => r.status === "force_exited").length,
      records,
    };
    res.json(response);
  }
);

// ============================================================
// 8. 出席CSVエクスポート
// GET /admin/analytics/attendance/export/courses/:courseId
// ============================================================

router.get(
  "/admin/analytics/attendance/export/courses/:courseId",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    const records = await buildAttendanceRecords(ds, courseId);

    const header = "ユーザー名,メール,レッスン,入室時刻,退室時刻,ステータス,退室理由,所要時間（分）\n";
    const rows = records
      .map((r) =>
        [
          r.userName,
          r.userEmail,
          r.lessonTitle,
          r.entryAt,
          r.exitAt ?? "",
          r.status,
          r.exitReason ?? "",
          String(r.durationMin),
        ]
          .map((v) => `"${v.replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");

    const bom = "\uFEFF";
    const csv = bom + header + rows;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance-${courseId}.csv"`
    );
    res.send(csv);
  }
);

export const analyticsRouter = router;
