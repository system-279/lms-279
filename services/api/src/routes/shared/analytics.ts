/**
 * 分析APIルーター
 * 管理者向けの分析・統計エンドポイント
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";

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

    const users = await ds.getUsers();
    const students = users.filter((u) => u.role === "student");

    const studentProgresses = await Promise.all(
      students.map(async (student) => {
        const progress = await ds.getCourseProgress(student.id, courseId);
        return { student, progress };
      })
    );

    const totalStudents = students.length;
    const completedStudents = studentProgresses.filter(
      ({ progress }) => progress?.isCompleted === true
    ).length;

    const progressRatios = studentProgresses
      .map(({ progress }) => progress?.progressRatio ?? 0);
    const avgProgressRatio =
      totalStudents > 0
        ? progressRatios.reduce((sum, r) => sum + r, 0) / totalStudents
        : 0;

    const studentList = studentProgresses.map(({ student, progress }) => ({
      userId: student.id,
      userName: student.name,
      email: student.email,
      completedLessons: progress?.completedLessons ?? 0,
      totalLessons: progress?.totalLessons ?? course.lessonOrder.length,
      progressRatio: progress?.progressRatio ?? 0,
      isCompleted: progress?.isCompleted ?? false,
    }));

    res.json({
      course: { id: course.id, name: course.name },
      totalStudents,
      completedStudents,
      avgProgressRatio,
      students: studentList,
    });
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

    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      courses,
    });
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

    const users = await ds.getUsers();
    const students = users.filter((u) => u.role === "student");

    const viewerAnalytics = await Promise.all(
      students.map(async (student) => {
        const analytics = await ds.getVideoAnalytics(student.id, videoId);
        return { student, analytics };
      })
    );

    const viewers = viewerAnalytics.filter(({ analytics }) => analytics !== null);

    const totalViewers = viewers.length;
    const completedViewers = viewers.filter(
      ({ analytics }) => analytics!.isComplete
    ).length;

    const avgCoverageRatio =
      totalViewers > 0
        ? viewers.reduce((sum, { analytics }) => sum + analytics!.coverageRatio, 0) /
          totalViewers
        : 0;

    const avgWatchTimeSec =
      totalViewers > 0
        ? viewers.reduce(
            (sum, { analytics }) => sum + analytics!.totalWatchTimeSec,
            0
          ) / totalViewers
        : 0;

    const viewerList = viewers.map(({ student, analytics }) => ({
      userId: student.id,
      userName: student.name,
      coverageRatio: analytics!.coverageRatio,
      isComplete: analytics!.isComplete,
      seekCount: analytics!.seekCount,
      speedViolationCount: analytics!.speedViolationCount,
      suspiciousFlags: analytics!.suspiciousFlags,
    }));

    res.json({
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
    });
  }
);

// ============================================================
// 4. クイズ統計
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

    res.json({
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
    });
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

    const videos = await ds.getVideos();
    const users = await ds.getUsers();
    const students = users.filter((u) => u.role === "student");

    const suspiciousViewings: Array<{
      userId: string;
      userName: string | null;
      videoId: string;
      lessonTitle: string | null;
      coverageRatio: number;
      seekCount: number;
      speedViolationCount: number;
      suspiciousFlags: string[];
      updatedAt: string;
    }> = [];

    for (const video of videos) {
      const lesson = await ds.getLessonById(video.lessonId);

      for (const student of students) {
        const analytics = await ds.getVideoAnalytics(student.id, video.id);
        if (analytics && analytics.suspiciousFlags.length > 0) {
          suspiciousViewings.push({
            userId: student.id,
            userName: student.name,
            videoId: video.id,
            lessonTitle: lesson?.title ?? null,
            coverageRatio: analytics.coverageRatio,
            seekCount: analytics.seekCount,
            speedViolationCount: analytics.speedViolationCount,
            suspiciousFlags: analytics.suspiciousFlags,
            updatedAt: analytics.updatedAt,
          });
        }
      }
    }

    res.json({ suspiciousViewings });
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

export const analyticsRouter = router;
