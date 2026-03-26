/**
 * マスターコンテンツ管理API
 * _master 疑似テナント配下のコース・レッスン・動画・テストのCRUDおよび配信
 *
 * 認証: 親ルーター(super-admin.ts)の superAdminAuthMiddleware で保護済み
 */

import { Router, Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreDataSource } from "../datasource/firestore.js";
import type { Lesson, CourseStatus } from "../types/entities.js";
import { distributeCourseToTenant } from "../services/course-distributor.js";
import { generateUploadUrl, generatePlaybackUrl } from "../services/gcs.js";
import { isWorkspaceIntegrationAvailable } from "../services/google-auth.js";
import {
  prepareDriveImport,
  isValidationError,
  startAsyncDriveCopy,
} from "../services/drive-import.js";
import { parseDocsUrl, getDocumentContent } from "../services/google-docs.js";
import { generateQuizQuestions } from "../services/quiz-generator.js";
import { resolveAndImportQuiz } from "../services/quiz-import.js";
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

  const [lessons, videos, quizzes] = await Promise.all([
    ds.getLessons({ courseId: id }),
    ds.getVideos({ courseId: id }),
    ds.getQuizzes({ courseId: id }),
  ]);

  res.json({
    course: serializeCourse(course),
    lessons: lessons.map(serializeLesson),
    videos: videos.map((v) => ({
      id: v.id,
      lessonId: v.lessonId,
      sourceType: v.sourceType,
      durationSec: v.durationSec,
      gcsPath: v.gcsPath ?? null,
    })),
    quizzes: quizzes.map((q) => ({
      id: q.id,
      lessonId: q.lessonId,
      title: q.title,
      questionCount: q.questions.length,
      passThreshold: q.passThreshold,
    })),
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
 * マスターコース公開
 * PATCH /master/courses/:id/publish
 */
router.patch("/master/courses/:id/publish", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  if (existing.status === "published") {
    res.status(409).json({ error: "already_published", message: "このコースは既に公開されています。" });
    return;
  }

  if (existing.status === "archived") {
    res.status(409).json({ error: "cannot_publish_archived", message: "アーカイブ済みのコースは公開できません。" });
    return;
  }

  const course = await ds.updateCourse(id, { status: "published" });
  res.json({ course: serializeCourse(course!) });
});

/**
 * マスターコースアーカイブ
 * PATCH /master/courses/:id/archive
 */
router.patch("/master/courses/:id/archive", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getCourseById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "マスターコースが見つかりません。" });
    return;
  }

  if (existing.status === "archived") {
    res.status(409).json({ error: "already_archived", message: "このコースは既にアーカイブされています。" });
    return;
  }

  const course = await ds.updateCourse(id, { status: "archived" });
  res.json({ course: serializeCourse(course!) });
});

/**
 * マスターコース削除（関連レッスン・動画・テストも削除）
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
 * マスターレッスン削除（動画・テストも削除、コースのlessonOrderからも除去）
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

  // 関連動画・テスト・コースを並列取得
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
// 動画アップロード
// ============================================================

/**
 * マスター動画アップロード用の署名付きURL発行
 * POST /master/videos/upload-url
 */
router.post("/master/videos/upload-url", async (req: Request, res: Response) => {
  const { fileName, contentType } = req.body;

  if (!fileName || typeof fileName !== "string" || fileName.trim() === "") {
    res.status(400).json({ error: "invalid_fileName", message: "fileName is required" });
    return;
  }
  if (!contentType || typeof contentType !== "string" || contentType.trim() === "") {
    res.status(400).json({ error: "invalid_contentType", message: "contentType is required" });
    return;
  }

  const { uploadUrl, gcsPath } = await generateUploadUrl(fileName.trim(), contentType.trim(), "_master");
  res.status(200).json({ uploadUrl, gcsPath });
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

  const result = await prepareDriveImport(ds, req.body, { replaceExisting: true });
  if (isValidationError(result)) {
    res.status(result.status).json({ error: result.error, message: result.message });
    return;
  }

  const { video, metadata, fileId } = result;
  startAsyncDriveCopy(ds, video.id, video.lessonId, fileId, "_master", metadata);

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
// Google Docsテスト自動生成
// ============================================================

/**
 * マスターレッスン用テストをGoogle Docsから自動生成（プレビュー用）
 * POST /master/lessons/:lessonId/quiz/generate
 */
router.post("/master/lessons/:lessonId/quiz/generate", async (req: Request, res: Response) => {
  if (!isWorkspaceIntegrationAvailable()) {
    res.status(503).json({
      error: "workspace_not_configured",
      message: "Google Workspace integration is not configured",
    });
    return;
  }

  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;
  const { docsUrl, questionCount, language, difficulty } = req.body;

  if (!docsUrl || typeof docsUrl !== "string") {
    res.status(400).json({ error: "invalid_docsUrl", message: "docsUrl is required" });
    return;
  }

  let documentId: string;
  try {
    documentId = parseDocsUrl(docsUrl);
  } catch {
    res.status(400).json({ error: "invalid_docsUrl", message: "Invalid Google Docs URL format" });
    return;
  }

  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  let docTitle: string;
  let docContent: string;
  try {
    const doc = await getDocumentContent(documentId);
    docTitle = doc.title;
    docContent = doc.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : "ドキュメントの読み取りに失敗しました";
    res.status(400).json({ error: "docs_read_failed", message });
    return;
  }

  try {
    const questions = await generateQuizQuestions(docContent, {
      questionCount: typeof questionCount === "number" ? questionCount : undefined,
      language: language === "en" ? "en" : "ja",
      difficulty: ["easy", "medium", "hard"].includes(difficulty) ? difficulty : undefined,
    });

    res.json({
      generatedQuestions: questions,
      documentTitle: docTitle,
      suggestedTitle: `${docTitle} - テスト`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "テスト生成に失敗しました";
    res.status(500).json({ error: "quiz_generation_failed", message });
  }
});

/**
 * マスターレッスン用テストをGoogle Docsテストタブからインポート（プレビュー用）
 * POST /master/lessons/:lessonId/quiz/import
 */
router.post("/master/lessons/:lessonId/quiz/import", async (req: Request, res: Response) => {
  if (!isWorkspaceIntegrationAvailable()) {
    res.status(503).json({
      error: "workspace_not_configured",
      message: "Google Workspace integration is not configured",
    });
    return;
  }

  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;
  const { docsUrl, tabId } = req.body;

  if (!docsUrl || typeof docsUrl !== "string") {
    res.status(400).json({ error: "invalid_docsUrl", message: "docsUrl is required" });
    return;
  }

  let documentId: string;
  try {
    documentId = parseDocsUrl(docsUrl);
  } catch {
    res.status(400).json({ error: "invalid_docsUrl", message: "Invalid Google Docs URL format" });
    return;
  }

  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  try {
    const result = await resolveAndImportQuiz(
      documentId,
      typeof tabId === "string" ? tabId : null,
      { language: "ja" }
    );
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "テストインポートに失敗しました";
    const isTabNotFound = error instanceof Error && error.message.includes("Tab not found");
    const isTransient =
      error instanceof Error &&
      "status" in error &&
      [429, 503].includes((error as { status: number }).status);

    res.status(isTabNotFound ? 400 : isTransient ? 503 : 500).json({
      error: isTabNotFound ? "tab_not_found" : "quiz_import_failed",
      message,
    });
  }
});

// ============================================================
// テストCRUD
// ============================================================

/**
 * マスターレッスンにテストを作成/置換
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

  // 既存のテストがあれば削除
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
 * マスターレッスン個別取得
 * GET /master/lessons/:lessonId
 */
router.get("/master/lessons/:lessonId", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;

  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "レッスンが見つかりません。" });
    return;
  }

  res.json({ lesson });
});

/**
 * マスター動画の署名付き再生URL取得
 * GET /master/videos/:videoId/playback-url
 */
router.get("/master/videos/:videoId/playback-url", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const videoId = req.params.videoId as string;

  const video = await ds.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "動画が見つかりません。" });
    return;
  }

  let playbackUrl: string;
  if (video.sourceType === "external_url" && video.sourceUrl) {
    playbackUrl = video.sourceUrl;
  } else if (video.gcsPath) {
    playbackUrl = await generatePlaybackUrl(video.gcsPath);
  } else {
    res.status(404).json({ error: "no_playback_source", message: "再生可能なソースがありません。" });
    return;
  }

  res.json({
    playbackUrl,
    video: {
      id: video.id,
      durationSec: video.durationSec,
      requiredWatchRatio: video.requiredWatchRatio ?? 0.95,
      speedLock: video.speedLock ?? true,
    },
  });
});

/**
 * マスターテスト個別取得
 * GET /master/quizzes/:id
 */
router.get("/master/quizzes/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const quiz = await ds.getQuizById(id);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "テストが見つかりません。" });
    return;
  }

  res.json({ quiz });
});

/**
 * マスターテスト更新
 * PATCH /master/quizzes/:id
 */
router.patch("/master/quizzes/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getQuizById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "テストが見つかりません。" });
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
 * マスターテスト削除
 * DELETE /master/quizzes/:id
 */
router.delete("/master/quizzes/:id", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const id = req.params.id as string;

  const existing = await ds.getQuizById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "テストが見つかりません。" });
    return;
  }

  await ds.deleteQuiz(id);

  // レッスンのhasQuizをfalseに更新
  await ds.updateLesson(existing.lessonId, { hasQuiz: false });

  res.status(204).send();
});

/**
 * レッスンIDからテストを削除
 * DELETE /master/lessons/:lessonId/quiz
 */
router.delete("/master/lessons/:lessonId/quiz", async (req: Request, res: Response) => {
  const ds = getMasterDS();
  const lessonId = req.params.lessonId as string;

  const quiz = await ds.getQuizByLessonId(lessonId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "テストが見つかりません。" });
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
  const { courseIds, tenantIds, force } = req.body;

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
      distributeCourseToTenant(db, courseId, tenantId, distributedBy, { force: !!force }),
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
