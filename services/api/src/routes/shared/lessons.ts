/**
 * レッスン関連の共通ルーター
 * DataSourceを使用してデモ/本番両対応
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";

const router = Router();

// ============================================================
// 管理者向けエンドポイント（全て requireAdmin）
// ============================================================

/**
 * レッスン一覧取得
 * GET /admin/courses/:courseId/lessons
 */
router.get("/admin/courses/:courseId/lessons", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const courseId = req.params.courseId as string;

  const course = await ds.getCourseById(courseId);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  const lessons = await ds.getLessons({ courseId });

  // lessonOrderに従い並び替え
  const lessonMap = new Map(lessons.map((l) => [l.id, l]));
  const orderedLessons = course.lessonOrder
    .map((lessonId) => lessonMap.get(lessonId))
    .filter((l): l is NonNullable<typeof l> => l !== undefined);
  const unorderedLessons = lessons.filter((l) => !course.lessonOrder.includes(l.id));
  const allLessons = [...orderedLessons, ...unorderedLessons];

  res.json({
    lessons: allLessons.map((lesson) => ({
      id: lesson.id,
      courseId: lesson.courseId,
      title: lesson.title,
      order: lesson.order,
      hasVideo: lesson.hasVideo,
      hasQuiz: lesson.hasQuiz,
      videoUnlocksPrior: lesson.videoUnlocksPrior,
      createdAt: lesson.createdAt.toISOString(),
      updatedAt: lesson.updatedAt.toISOString(),
    })),
  });
});

/**
 * レッスン作成
 * POST /admin/courses/:courseId/lessons
 * ボディ:
 *   - title: string (必須)
 *   - hasVideo?: boolean
 *   - hasQuiz?: boolean
 *   - videoUnlocksPrior?: boolean
 */
router.post("/admin/courses/:courseId/lessons", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const courseId = req.params.courseId as string;
  const { title, hasVideo, hasQuiz, videoUnlocksPrior } = req.body;

  const course = await ds.getCourseById(courseId);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  if (!title || typeof title !== "string" || title.trim() === "") {
    res.status(400).json({ error: "invalid_title", message: "title is required" });
    return;
  }

  // orderは現在のレッスン数 + 1
  const existingLessons = await ds.getLessons({ courseId });
  const order = existingLessons.length + 1;

  const lesson = await ds.createLesson({
    courseId,
    title: title.trim(),
    order,
    hasVideo: hasVideo ?? false,
    hasQuiz: hasQuiz ?? false,
    videoUnlocksPrior: videoUnlocksPrior ?? false,
  });

  // courseのlessonOrderにも追加
  await ds.updateCourse(courseId, {
    lessonOrder: [...course.lessonOrder, lesson.id],
  });

  res.status(201).json({
    lesson: {
      id: lesson.id,
      courseId: lesson.courseId,
      title: lesson.title,
      order: lesson.order,
      hasVideo: lesson.hasVideo,
      hasQuiz: lesson.hasQuiz,
      videoUnlocksPrior: lesson.videoUnlocksPrior,
      createdAt: lesson.createdAt.toISOString(),
      updatedAt: lesson.updatedAt.toISOString(),
    },
  });
});

/**
 * レッスン詳細取得
 * GET /admin/courses/:courseId/lessons/:lessonId
 */
router.get(
  "/admin/courses/:courseId/lessons/:lessonId",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;
    const lessonId = req.params.lessonId as string;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    const lesson = await ds.getLessonById(lessonId);
    if (!lesson || lesson.courseId !== courseId) {
      res.status(404).json({ error: "not_found", message: "Lesson not found" });
      return;
    }

    res.json({
      lesson: {
        id: lesson.id,
        courseId: lesson.courseId,
        title: lesson.title,
        order: lesson.order,
        hasVideo: lesson.hasVideo,
        hasQuiz: lesson.hasQuiz,
        videoUnlocksPrior: lesson.videoUnlocksPrior,
        createdAt: lesson.createdAt.toISOString(),
        updatedAt: lesson.updatedAt.toISOString(),
      },
    });
  }
);

/**
 * レッスン順序変更
 * PATCH /admin/courses/:courseId/lessons/reorder
 * ボディ:
 *   - lessonIds: string[] (新しい順序のレッスンIDリスト)
 *
 * NOTE: /:lessonId より前に登録することで "reorder" がパラメータと競合しない
 */
router.patch(
  "/admin/courses/:courseId/lessons/reorder",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;
    const { lessonIds } = req.body;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    if (!Array.isArray(lessonIds) || lessonIds.some((id) => typeof id !== "string")) {
      res.status(400).json({ error: "invalid_lesson_ids", message: "lessonIds must be an array of strings" });
      return;
    }

    // 指定されたIDが全て存在するか確認
    const existingLessons = await ds.getLessons({ courseId });
    const existingIds = new Set(existingLessons.map((l) => l.id));
    const invalidIds = lessonIds.filter((id) => !existingIds.has(id));
    if (invalidIds.length > 0) {
      res.status(400).json({
        error: "invalid_lesson_ids",
        message: "Some lesson IDs do not belong to this course",
        details: { invalidIds },
      });
      return;
    }

    await ds.reorderLessons(courseId, lessonIds);

    // courseのlessonOrderも更新
    await ds.updateCourse(courseId, { lessonOrder: lessonIds });

    res.json({ lessonOrder: lessonIds });
  }
);

/**
 * レッスン更新
 * PATCH /admin/courses/:courseId/lessons/:lessonId
 */
router.patch(
  "/admin/courses/:courseId/lessons/:lessonId",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;
    const lessonId = req.params.lessonId as string;
    const { title, hasVideo, hasQuiz, videoUnlocksPrior } = req.body;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    const existing = await ds.getLessonById(lessonId);
    if (!existing || existing.courseId !== courseId) {
      res.status(404).json({ error: "not_found", message: "Lesson not found" });
      return;
    }

    const lesson = await ds.updateLesson(lessonId, {
      ...(title !== undefined && { title }),
      ...(hasVideo !== undefined && { hasVideo }),
      ...(hasQuiz !== undefined && { hasQuiz }),
      ...(videoUnlocksPrior !== undefined && { videoUnlocksPrior }),
    });

    res.json({
      lesson: {
        id: lesson!.id,
        courseId: lesson!.courseId,
        title: lesson!.title,
        order: lesson!.order,
        hasVideo: lesson!.hasVideo,
        hasQuiz: lesson!.hasQuiz,
        videoUnlocksPrior: lesson!.videoUnlocksPrior,
        createdAt: lesson!.createdAt.toISOString(),
        updatedAt: lesson!.updatedAt.toISOString(),
      },
    });
  }
);

/**
 * レッスン削除
 * DELETE /admin/courses/:courseId/lessons/:lessonId
 */
router.delete(
  "/admin/courses/:courseId/lessons/:lessonId",
  requireAdmin,
  async (req: Request, res: Response) => {
    const ds = req.dataSource!;
    const courseId = req.params.courseId as string;
    const lessonId = req.params.lessonId as string;

    const course = await ds.getCourseById(courseId);
    if (!course) {
      res.status(404).json({ error: "not_found", message: "Course not found" });
      return;
    }

    const existing = await ds.getLessonById(lessonId);
    if (!existing || existing.courseId !== courseId) {
      res.status(404).json({ error: "not_found", message: "Lesson not found" });
      return;
    }

    // 紐づく動画・テストも削除（孤立防止）
    const [video, quiz] = await Promise.all([
      ds.getVideoByLessonId(lessonId),
      ds.getQuizByLessonId(lessonId),
    ]);
    await Promise.all([
      video ? ds.deleteVideo(video.id) : Promise.resolve(false),
      quiz ? ds.deleteQuiz(quiz.id) : Promise.resolve(false),
    ]);

    await ds.deleteLesson(lessonId);

    // courseのlessonOrderからも削除
    await ds.updateCourse(courseId, {
      lessonOrder: course.lessonOrder.filter((id) => id !== lessonId),
    });

    res.status(204).send();
  }
);

export const lessonsRouter = router;
