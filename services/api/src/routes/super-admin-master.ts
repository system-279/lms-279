/**
 * マスターコンテンツ管理API
 * _master 疑似テナント配下のコース・レッスン・動画・クイズのCRUDおよび配信
 *
 * 認証: 親ルーター(super-admin.ts)の superAdminAuthMiddleware で保護済み
 */

import { Router, Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreDataSource } from "../datasource/firestore.js";
import type { Lesson, CourseStatus } from "../types/entities.js";
import { distributeCourseToTenant } from "../services/course-distributor.js";
import { isWorkspaceIntegrationAvailable } from "../services/google-auth.js";
import {
  parseDriveUrl,
  getDriveFileMetadata,
  validateDriveFileMetadata,
  copyDriveFileToGCS,
} from "../services/google-drive.js";
import { serializeCourse } from "./shared/courses.js";

const router = Router();

const VALID_STATUSES: CourseStatus[] = ["draft", "published", "archived"];

// ============================================================
// ヘルパー
// ============================================================

function getMasterDS(): FirestoreDataSource {
  return new FirestoreDataSource(getFirestore(), "_master");
}

function serializeLesson(lesson: Lesson) {
  return {
    id: lesson.id,
    courseId: lesson.courseId,
    title: lesson.title,
    order: lesson.order,
    hasVideo: lesson.hasVideo,
    hasQuiz: lesson.hasQuiz,
    videoUnlocksPrior: lesson.videoUnlocksPrior,
    createdAt: lesson.createdAt.toISOString(),
    updatedAt: lesson.updatedAt.toISOString(),
  };
}

// ============================================================
// コースCRUD
// ============================================================

/**
 * マスターコース一覧取得
 * GET /master/courses
 * クエリ: ?status=draft|published|archived
 */
router.get("/master/courses", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const statusParam = req.query.status as string | undefined;

  if (statusParam && !VALID_STATUSES.includes(statusParam as CourseStatus)) {
    res.status(400).json({
      error: "invalid_status",
      message: "statusは 'draft', 'published', 'archived' のいずれかを指定してください。",
    });
    return;
  }

  const courses = await ds.getCourses(
    statusParam ? { status: statusParam as CourseStatus } : undefined,
  );

  res.json({ courses: courses.map(serializeCourse) });
});

/**
 * マスターコース作成
 * POST /master/courses
 */
router.post("/master/courses", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const { name, description, passThreshold } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    res.status(400).json({ error: "invalid_name", message: "nameは必須です。" });
    return;
  }

  const course = await ds.createCourse({
    name: name.trim(),
    description: description ?? null,
    status: "draft",
    lessonOrder: [],
    passThreshold: passThreshold ?? 80,
    createdBy: req.superAdmin?.email ?? "system",
  });

  res.status(201).json({ course: serializeCourse(course) });
});

/**
 * マスターコース詳細 + レッスン一覧
 * GET /master/courses/:id
 */
router.get("/master/courses/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const course = await ds.getCourseById(id);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  const lessons = await ds.getLessons({ courseId: id });

  res.json({
    course: serializeCourse(course),
    lessons: lessons.map(serializeLesson),
  });
});

/**
 * マスターコース更新
 * PATCH /master/courses/:id
 */
router.patch("/master/courses/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;
  const { name, description, passThreshold } = req.body;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  const course = await ds.updateCourse(id, {
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(passThreshold !== undefined && { passThreshold }),
  });

  res.json({ course: serializeCourse(course!) });
});

/**
 * マスターコース削除（関連レッスン・動画・クイズも削除）
 * DELETE /master/courses/:id
 */
router.delete("/master/courses/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  // 関連データを並列取得して一括削除
  const [videos, quizzes, lessons] = await Promise.all([
    ds.getVideos({ courseId: id }),
    ds.getQuizzes({ courseId: id }),
    ds.getLessons({ courseId: id }),
  ]);
  await Promise.all([
    ...videos.map((v) => ds.deleteVideo(v.id)),
    ...quizzes.map((q) => ds.deleteQuiz(q.id)),
    ...lessons.map((l) => ds.deleteLesson(l.id)),
  ]);

  await ds.deleteCourse(id);

  console.log(
    `[SuperAdmin] Master course deleted: ${id} (${existing.name}) by ${req.superAdmin?.email}`,
  );

  res.json({ message: "マスターコースを削除しました。" });
});

// ============================================================
// レッスンCRUD
// ============================================================

/**
 * マスターコースのレッスン一覧
 * GET /master/courses/:courseId/lessons
 */
router.get("/master/courses/:courseId/lessons", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const courseId = req.params.courseId as string;

  const course = await ds.getCourseById(courseId);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  const lessons = await ds.getLessons({ courseId });
  res.json({ lessons: lessons.map(serializeLesson) });
});

/**
 * マスターレッスン作成
 * POST /master/courses/:courseId/lessons
 */
router.post("/master/courses/:courseId/lessons", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const courseId = req.params.courseId as string;
  const { title } = req.body;

  const course = await ds.getCourseById(courseId);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  if (!title || typeof title !== "string" || title.trim() === "") {
    res.status(400).json({ error: "invalid_title", message: "titleは必須です。" });
    return;
  }

  // コースのlessonOrder長から次のorder値を算出
  const nextOrder = course.lessonOrder.length;

  const lesson = await ds.createLesson({
    courseId,
    title: title.trim(),
    order: nextOrder,
    hasVideo: false,
    hasQuiz: false,
    videoUnlocksPrior: false,
  });

  // コースのlessonOrderに追加
  await ds.updateCourse(courseId, {
    lessonOrder: [...course.lessonOrder, lesson.id],
  });

  res.status(201).json({ lesson: serializeLesson(lesson) });
});

/**
 * マスターレッスン更新
 * PATCH /master/lessons/:id
 */
router.patch("/master/lessons/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;
  const { title, videoUnlocksPrior } = req.body;

  const existing = await ds.getLessonById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  const lesson = await ds.updateLesson(id, {
    ...(title !== undefined && { title }),
    ...(videoUnlocksPrior !== undefined && { videoUnlocksPrior }),
  });

  res.json({ lesson: serializeLesson(lesson!) });
});

/**
 * マスターレッスン削除（動画・クイズも削除、コースのlessonOrderからも除去）
 * DELETE /master/lessons/:id
 */
router.delete("/master/lessons/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getLessonById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  // 関連動画・クイズ・コースを並列取得
  const [video, quiz, course] = await Promise.all([
    ds.getVideoByLessonId(id),
    ds.getQuizByLessonId(id),
    ds.getCourseById(existing.courseId),
  ]);
  if (video) await ds.deleteVideo(video.id);
  if (quiz) await ds.deleteQuiz(quiz.id);
  if (course) {
    await ds.updateCourse(existing.courseId, {
      lessonOrder: course.lessonOrder.filter((lid) => lid !== id),
    });
  }

  await ds.deleteLesson(id);

  res.status(204).send();
});

// ============================================================
// 動画CRUD
// ============================================================

/**
 * マスターレッスンに動画を作成/置換
 * POST /master/lessons/:lessonId/video
 */
router.post("/master/lessons/:lessonId/video", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;

  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  const { sourceType, sourceUrl, gcsPath, durationSec, requiredWatchRatio, speedLock } = req.body;

  // 既存の動画があれば削除
  const existingVideo = await ds.getVideoByLessonId(lessonId);
  if (existingVideo) {
    await ds.deleteVideo(existingVideo.id);
  }

  const video = await ds.createVideo({
    lessonId,
    courseId: lesson.courseId,
    sourceType: sourceType ?? "gcs",
    ...(sourceUrl !== undefined && { sourceUrl }),
    ...(gcsPath !== undefined && { gcsPath }),
    durationSec: durationSec ?? 0,
    requiredWatchRatio: requiredWatchRatio ?? 0.95,
    speedLock: speedLock ?? true,
  });

  // レッスンのhasVideoをtrueに更新
  await ds.updateLesson(lessonId, { hasVideo: true });

  res.status(201).json({ video });
});

/**
 * マスター動画更新
 * PATCH /master/videos/:id
 */
router.patch("/master/videos/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getVideoById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "動画が見つかりません。" });
    return;
  }

  const { sourceType, sourceUrl, gcsPath, durationSec, requiredWatchRatio, speedLock } = req.body;

  const video = await ds.updateVideo(id, {
    ...(sourceType !== undefined && { sourceType }),
    ...(sourceUrl !== undefined && { sourceUrl }),
    ...(gcsPath !== undefined && { gcsPath }),
    ...(durationSec !== undefined && { durationSec }),
    ...(requiredWatchRatio !== undefined && { requiredWatchRatio }),
    ...(speedLock !== undefined && { speedLock }),
  });

  res.json({ video });
});

/**
 * マスター動画削除
 * DELETE /master/videos/:id
 */
router.delete("/master/videos/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getVideoById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "動画が見つかりません。" });
    return;
  }

  await ds.deleteVideo(id);

  // レッスンのhasVideoをfalseに更新
  await ds.updateLesson(existing.lessonId, { hasVideo: false });

  res.status(204).send();
});

/**
 * レッスンIDから動画を削除
 * DELETE /master/lessons/:lessonId/video
 */
router.delete("/master/lessons/:lessonId/video", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;

  const video = await ds.getVideoByLessonId(lessonId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "動画が見つかりません。" });
    return;
  }

  await ds.deleteVideo(video.id);
  await ds.updateLesson(lessonId, { hasVideo: false });

  res.status(204).send();
});

// ============================================================
// Google Drive動画インポート
// ============================================================

/**
 * マスターレッスンにGoogle Driveから動画をインポート
 * POST /master/videos/import-from-drive
 */
router.post("/master/videos/import-from-drive", async (req: Request, res: Response) => {
  if (!isWorkspaceIntegrationAvailable()) {
    res.status(503).json({
      error: "workspace_not_configured",
      message: "Google Workspace integration is not configured",
    });
    return;
  }

  const ds = getMasterDS();
  const { driveUrl, lessonId, durationSec, requiredWatchRatio, speedLock } = req.body;

  if (!driveUrl || typeof driveUrl !== "string") {
    res.status(400).json({ error: "invalid_driveUrl", message: "driveUrl is required" });
    return;
  }
  if (!lessonId || typeof lessonId !== "string") {
    res.status(400).json({ error: "invalid_lessonId", message: "lessonId is required" });
    return;
  }

  let fileId: string;
  try {
    fileId = parseDriveUrl(driveUrl);
  } catch {
    res.status(400).json({ error: "invalid_driveUrl", message: "Invalid Google Drive URL format" });
    return;
  }

  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  // 既存動画があれば削除
  const existingVideo = await ds.getVideoByLessonId(lessonId);
  if (existingVideo) {
    await ds.deleteVideo(existingVideo.id);
  }

  // Driveファイルメタデータ検証
  let metadata: { name: string; mimeType: string; size: string };
  try {
    metadata = await getDriveFileMetadata(fileId);
    validateDriveFileMetadata(metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to validate Drive file";
    res.status(400).json({ error: "drive_file_invalid", message });
    return;
  }

  const video = await ds.createVideo({
    lessonId,
    courseId: lesson.courseId,
    sourceType: "google_drive",
    driveFileId: fileId,
    importStatus: "pending",
    durationSec: durationSec ?? 0,
    requiredWatchRatio: requiredWatchRatio ?? 0.95,
    speedLock: speedLock ?? true,
  });

  await ds.updateLesson(lessonId, { hasVideo: true });

  // 非同期でDrive→GCSコピー（マスターは_masterテナント）
  (async () => {
    try {
      await ds.updateVideo(video.id, { importStatus: "importing" });
      const { gcsPath } = await copyDriveFileToGCS(fileId, "_master");
      await ds.updateVideo(video.id, {
        gcsPath,
        importStatus: "completed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import error";
      console.error(`Drive import failed for master video ${video.id}:`, message);
      try {
        await ds.updateVideo(video.id, {
          importStatus: "error",
          importError: message,
        });
      } catch (updateError) {
        console.error(`Failed to update import status for master video ${video.id}:`, updateError);
      }
    }
  })();

  res.status(202).json({ video });
});

/**
 * マスター動画のインポートステータス確認
 * GET /master/videos/:videoId/import-status
 */
router.get("/master/videos/:videoId/import-status", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const videoId = req.params.videoId as string;

  const video = await ds.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "動画が見つかりません。" });
    return;
  }

  res.json({
    videoId: video.id,
    sourceType: video.sourceType,
    importStatus: video.importStatus ?? null,
    importError: video.importError ?? null,
    gcsPath: video.gcsPath ?? null,
  });
});

// ============================================================
// クイズCRUD
// ============================================================

/**
 * マスターレッスンにクイズを作成/置換
 * POST /master/lessons/:lessonId/quiz
 */
router.post("/master/lessons/:lessonId/quiz", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;

  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  const {
    title,
    passThreshold,
    maxAttempts,
    timeLimitSec,
    randomizeQuestions,
    randomizeAnswers,
    requireVideoCompletion,
    questions,
  } = req.body;

  if (!title || typeof title !== "string" || title.trim() === "") {
    res.status(400).json({ error: "invalid_title", message: "titleは必須です。" });
    return;
  }

  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    res.status(400).json({ error: "invalid_questions", message: "questionsは必須です。" });
    return;
  }

  // 既存のクイズがあれば削除
  const existingQuiz = await ds.getQuizByLessonId(lessonId);
  if (existingQuiz) {
    await ds.deleteQuiz(existingQuiz.id);
  }

  const quiz = await ds.createQuiz({
    lessonId,
    courseId: lesson.courseId,
    title: title.trim(),
    passThreshold: passThreshold ?? 70,
    maxAttempts: maxAttempts ?? 3,
    timeLimitSec: timeLimitSec ?? null,
    randomizeQuestions: randomizeQuestions ?? false,
    randomizeAnswers: randomizeAnswers ?? false,
    requireVideoCompletion: requireVideoCompletion ?? true,
    questions,
  });

  // レッスンのhasQuizをtrueに更新
  await ds.updateLesson(lessonId, { hasQuiz: true });

  res.status(201).json({ quiz });
});

/**
 * マスタークイズ更新
 * PATCH /master/quizzes/:id
 */
router.patch("/master/quizzes/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getQuizById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "クイズが見つかりません。" });
    return;
  }

  const {
    title,
    passThreshold,
    maxAttempts,
    timeLimitSec,
    randomizeQuestions,
    randomizeAnswers,
    requireVideoCompletion,
    questions,
  } = req.body;

  const quiz = await ds.updateQuiz(id, {
    ...(title !== undefined && { title }),
    ...(passThreshold !== undefined && { passThreshold }),
    ...(maxAttempts !== undefined && { maxAttempts }),
    ...(timeLimitSec !== undefined && { timeLimitSec }),
    ...(randomizeQuestions !== undefined && { randomizeQuestions }),
    ...(randomizeAnswers !== undefined && { randomizeAnswers }),
    ...(requireVideoCompletion !== undefined && { requireVideoCompletion }),
    ...(questions !== undefined && { questions }),
  });

  res.json({ quiz });
});

/**
 * マスタークイズ削除
 * DELETE /master/quizzes/:id
 */
router.delete("/master/quizzes/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getQuizById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "クイズが見つかりません。" });
    return;
  }

  await ds.deleteQuiz(id);

  // レッスンのhasQuizをfalseに更新
  await ds.updateLesson(existing.lessonId, { hasQuiz: false });

  res.status(204).send();
});

/**
 * レッスンIDからクイズを削除
 * DELETE /master/lessons/:lessonId/quiz
 */
router.delete("/master/lessons/:lessonId/quiz", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;

  const quiz = await ds.getQuizByLessonId(lessonId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "クイズが見つかりません。" });
    return;
  }

  await ds.deleteQuiz(quiz.id);
  await ds.updateLesson(lessonId, { hasQuiz: false });

  res.status(204).send();
});

// ============================================================
// 配信
// ============================================================

/**
 * マスターコースをテナントに配信
 * POST /master/distribute
 */
router.post("/master/distribute", async (req: Request, res: Response) => {
  const { courseIds, tenantIds } = req.body;

  if (!Array.isArray(courseIds) || courseIds.length === 0 || !courseIds.every((id: unknown) => typeof id === "string")) {
    res.status(400).json({
      error: "invalid_course_ids",
      message: "courseIdsは空でない文字列配列を指定してください。",
    });
    return;
  }

  if (!Array.isArray(tenantIds) || tenantIds.length === 0 || !tenantIds.every((id: unknown) => typeof id === "string")) {
    res.status(400).json({
      error: "invalid_tenant_ids",
      message: "tenantIdsは空でない文字列配列を指定してください。",
    });
    return;
  }

  const db = getFirestore();
  const distributedBy = req.superAdmin?.email ?? "system";

  const pairs = courseIds.flatMap((courseId: string) =>
    tenantIds.map((tenantId: string) => ({ courseId, tenantId })),
  );

  const results = await Promise.all(
    pairs.map(({ courseId, tenantId }) =>
      distributeCourseToTenant(db, courseId, tenantId, distributedBy),
    ),
  );

  res.json({ results });
});

/**
 * マスターコースの配信状況を確認
 * GET /master/courses/:id/distributions
 */
router.get("/master/courses/:id/distributions", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const course = await ds.getCourseById(id);
  if (!course) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  const db = getFirestore();
  const tenantsSnap = await db.collection("tenants").get();
  const tenantDocs = tenantsSnap.docs.filter((d) => d.id !== "_master");

  // 全テナントへのクエリを並列実行
  const snapshots = await Promise.all(
    tenantDocs.map((doc) =>
      db.collection(`tenants/${doc.id}/courses`)
        .where("sourceMasterCourseId", "==", id)
        .get(),
    ),
  );

  const distributions = tenantDocs.flatMap((tenantDoc, idx) =>
    snapshots[idx].docs.map((courseDoc) => {
      const data = courseDoc.data();
      return {
        tenantId: tenantDoc.id,
        tenantName: tenantDoc.data().name ?? tenantDoc.id,
        courseId: courseDoc.id,
        courseName: data.name,
        status: data.status,
        copiedAt: data.copiedAt?.toDate?.()?.toISOString() ?? null,
      };
    }),
  );

  res.json({ distributions });
});

export const masterRouter = router;
