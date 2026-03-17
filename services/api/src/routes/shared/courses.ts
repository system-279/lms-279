/**
 * 講座関連の共通ルーター
 * DataSourceを使用してデモ/本番両対応
 */

import { Router, Request, Response } from "express";
import { requireUser, requireAdmin } from "../../middleware/auth.js";
import type { CourseStatus } from "../../types/entities.js";

const VALID_STATUSES: CourseStatus[] = ["draft", "published", "archived"];

const router = Router();

// ============================================================
// 管理者向けエンドポイント
// ============================================================

/**
 * 管理者向け: 講座一覧取得
 * GET /admin/courses
 * クエリパラメータ:
 *   - status: "draft" | "published" | "archived"
 */
router.get("/admin/courses", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const statusParam = req.query.status as string | undefined;

  if (statusParam && !VALID_STATUSES.includes(statusParam as CourseStatus)) {
    res.status(400).json({ error: "invalid_status", message: "status must be draft, published, or archived" });
    return;
  }

  const courses = await ds.getCourses(
    statusParam ? { status: statusParam as CourseStatus } : undefined
  );

  res.json({
    courses: courses.map((course) => ({
      id: course.id,
      name: course.name,
      description: course.description,
      status: course.status,
      lessonOrder: course.lessonOrder,
      passThreshold: course.passThreshold,
      createdBy: course.createdBy,
      createdAt: course.createdAt.toISOString(),
      updatedAt: course.updatedAt.toISOString(),
    })),
  });
});

/**
 * 管理者向け: 講座作成
 * POST /admin/courses
 * ボディ:
 *   - name: string (必須)
 *   - description: string (必須)
 *   - passThreshold?: number
 */
router.post("/admin/courses", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const { name, description, passThreshold } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    res.status(400).json({ error: "invalid_name", message: "name is required" });
    return;
  }

  if (description === undefined || description === null) {
    res.status(400).json({ error: "invalid_description", message: "description is required" });
    return;
  }

  const course = await ds.createCourse({
    name: name.trim(),
    description: typeof description === "string" ? description : String(description),
    status: "draft",
    lessonOrder: [],
    passThreshold: passThreshold ?? 80,
    createdBy: req.user!.id,
  });

  res.status(201).json({
    course: {
      id: course.id,
      name: course.name,
      description: course.description,
      status: course.status,
      lessonOrder: course.lessonOrder,
      passThreshold: course.passThreshold,
      createdBy: course.createdBy,
      createdAt: course.createdAt.toISOString(),
      updatedAt: course.updatedAt.toISOString(),
    },
  });
});

/**
 * 管理者向け: 講座詳細取得
 * GET /admin/courses/:id
 */
router.get("/admin/courses/:id", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const course = await ds.getCourseById(id);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  res.json({
    course: {
      id: course.id,
      name: course.name,
      description: course.description,
      status: course.status,
      lessonOrder: course.lessonOrder,
      passThreshold: course.passThreshold,
      createdBy: course.createdBy,
      createdAt: course.createdAt.toISOString(),
      updatedAt: course.updatedAt.toISOString(),
    },
  });
});

/**
 * 管理者向け: 講座更新
 * PATCH /admin/courses/:id
 */
router.patch("/admin/courses/:id", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;
  const { name, description, passThreshold } = req.body;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  const course = await ds.updateCourse(id, {
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(passThreshold !== undefined && { passThreshold }),
  });

  res.json({
    course: {
      id: course!.id,
      name: course!.name,
      description: course!.description,
      status: course!.status,
      lessonOrder: course!.lessonOrder,
      passThreshold: course!.passThreshold,
      createdBy: course!.createdBy,
      createdAt: course!.createdAt.toISOString(),
      updatedAt: course!.updatedAt.toISOString(),
    },
  });
});

/**
 * 管理者向け: 講座削除
 * DELETE /admin/courses/:id
 */
router.delete("/admin/courses/:id", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  // 公開済み講座の削除は禁止
  if (existing.status === "published") {
    res.status(409).json({
      error: "cannot_delete_published",
      message: "Cannot delete a published course. Archive it first.",
    });
    return;
  }

  await ds.deleteCourse(id);
  res.status(204).send();
});

/**
 * 管理者向け: 講座公開
 * PATCH /admin/courses/:id/publish
 */
router.patch("/admin/courses/:id/publish", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  if (existing.status === "published") {
    res.status(409).json({ error: "already_published", message: "Course is already published" });
    return;
  }

  if (existing.status === "archived") {
    res.status(409).json({ error: "cannot_publish_archived", message: "Cannot publish an archived course" });
    return;
  }

  const course = await ds.updateCourse(id, { status: "published" });

  res.json({
    course: {
      id: course!.id,
      name: course!.name,
      description: course!.description,
      status: course!.status,
      lessonOrder: course!.lessonOrder,
      passThreshold: course!.passThreshold,
      createdBy: course!.createdBy,
      createdAt: course!.createdAt.toISOString(),
      updatedAt: course!.updatedAt.toISOString(),
    },
  });
});

/**
 * 管理者向け: 講座アーカイブ
 * PATCH /admin/courses/:id/archive
 */
router.patch("/admin/courses/:id/archive", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  if (existing.status === "archived") {
    res.status(409).json({ error: "already_archived", message: "Course is already archived" });
    return;
  }

  const course = await ds.updateCourse(id, { status: "archived" });

  res.json({
    course: {
      id: course!.id,
      name: course!.name,
      description: course!.description,
      status: course!.status,
      lessonOrder: course!.lessonOrder,
      passThreshold: course!.passThreshold,
      createdBy: course!.createdBy,
      createdAt: course!.createdAt.toISOString(),
      updatedAt: course!.updatedAt.toISOString(),
    },
  });
});

// ============================================================
// 受講者向けエンドポイント
// ============================================================

/**
 * 受講者向け: 公開講座一覧取得
 * GET /courses
 * status=published のみ返す
 */
router.get("/courses", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;

  const courses = await ds.getCourses({ status: "published" });

  res.json({
    courses: courses.map((course) => ({
      id: course.id,
      name: course.name,
      description: course.description,
      status: course.status,
      lessonOrder: course.lessonOrder,
      passThreshold: course.passThreshold,
    })),
  });
});

/**
 * 受講者向け: 講座詳細 + レッスン一覧取得
 * GET /courses/:id
 */
router.get("/courses/:id", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const course = await ds.getCourseById(id);
  if (!course || course.status !== "published") {
    res.status(404).json({ error: "not_found", message: "Course not found" });
    return;
  }

  // レッスン一覧を取得し、lessonOrderに従い並び替え
  const lessons = await ds.getLessons({ courseId: id });
  const lessonMap = new Map(lessons.map((l) => [l.id, l]));
  const orderedLessons = course.lessonOrder
    .map((lessonId) => lessonMap.get(lessonId))
    .filter((l): l is NonNullable<typeof l> => l !== undefined);

  // lessonOrderに含まれていないレッスンも末尾に追加
  const unorderedLessons = lessons.filter((l) => !course.lessonOrder.includes(l.id));
  const allLessons = [...orderedLessons, ...unorderedLessons];

  res.json({
    course: {
      id: course.id,
      name: course.name,
      description: course.description,
      status: course.status,
      passThreshold: course.passThreshold,
    },
    lessons: allLessons.map((lesson) => ({
      id: lesson.id,
      courseId: lesson.courseId,
      title: lesson.title,
      order: lesson.order,
      hasVideo: lesson.hasVideo,
      hasQuiz: lesson.hasQuiz,
      videoUnlocksPrior: lesson.videoUnlocksPrior,
    })),
  });
});

export const coursesRouter = router;
