/**
 * 進捗トラッキングルーター
 */

import { Router, Request, Response } from "express";
import { requireUser, requireAdmin } from "../../middleware/auth.js";

const router = Router();

// ============================================================
// 受講者向けエンドポイント
// ============================================================

/**
 * 受講者向け: 自分のコース進捗取得
 * GET /courses/:courseId/progress
 */
router.get("/courses/:courseId/progress", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const courseId = req.params.courseId as string;

  const course = await ds.getCourseById(courseId);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  const [courseProgress, userProgresses] = await Promise.all([
    ds.getCourseProgress(userId, courseId),
    ds.getUserProgressByCourse(userId, courseId),
  ]);

  const lessonProgresses = userProgresses.map((p) => ({
    lessonId: p.lessonId,
    videoCompleted: p.videoCompleted,
    quizPassed: p.quizPassed,
    lessonCompleted: p.lessonCompleted,
  }));

  res.json({
    courseProgress: courseProgress
      ? {
          completedLessonCount: courseProgress.completedLessons,
          totalLessonCount: courseProgress.totalLessons,
          progressRatio: courseProgress.progressRatio,
          courseCompleted: courseProgress.isCompleted,
        }
      : {
          completedLessonCount: 0,
          totalLessonCount: course.lessonOrder.length,
          progressRatio: 0,
          courseCompleted: false,
        },
    lessonProgresses,
  });
});

/**
 * 受講者向け: 自分のレッスン進捗取得
 * GET /courses/:courseId/lessons/:lessonId/progress
 */
router.get(
  "/courses/:courseId/lessons/:lessonId/progress",
  requireUser,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const userId = req.user!.id;
    const lessonId = req.params.lessonId as string;
    const courseId = req.params.courseId as string;

    const progress = await ds.getUserProgress(userId, lessonId);

    if (!progress) {
      res.json({
        progress: {
          userId,
          lessonId,
          courseId,
          videoCompleted: false,
          quizPassed: false,
          quizBestScore: null,
          lessonCompleted: false,
          updatedAt: null,
        },
      });
      return;
    }

    res.json({
      progress: {
        userId: progress.userId,
        lessonId: progress.lessonId,
        courseId: progress.courseId,
        videoCompleted: progress.videoCompleted,
        quizPassed: progress.quizPassed,
        quizBestScore: progress.quizBestScore,
        lessonCompleted: progress.lessonCompleted,
        updatedAt: progress.updatedAt,
      },
    });
  }
);

// ============================================================
// 管理者向けエンドポイント
// ============================================================

/**
 * 管理者向け: 全受講者のコース進捗一覧
 * GET /admin/courses/:courseId/progress
 */
router.get(
  "/admin/courses/:courseId/progress",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    // 全受講者(student)を取得し、各ユーザーのコース進捗を収集
    const users = await ds.getUsers();
    const students = users.filter((u) => u.role === "student");

    const progressList = await Promise.all(
      students.map(async (user) => {
        return ds.getCourseProgress(user.id, courseId);
      })
    );

    res.json({
      courseId,
      progressList: progressList
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => ({
          userId: p.userId,
          courseId: p.courseId,
          completedLessons: p.completedLessons,
          totalLessons: p.totalLessons,
          progressRatio: p.progressRatio,
          isCompleted: p.isCompleted,
          updatedAt: p.updatedAt,
        })),
    });
  }
);

export const progressRouter = router;
