/**
 * コース配布サービス
 * マスターテナント（_master）から対象テナントへコースをディープコピーする
 */

import {
  Firestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import { FirestoreDataSource } from "../datasource/firestore.js";
import type { Course, Video, Quiz } from "../types/entities.js";

/** 配布結果 */
export interface DistributionResult {
  tenantId: string;
  courseId: string;
  masterCourseId: string;
  status: "success" | "skipped" | "error";
  reason?: string;
  lessonsCount: number;
  videosCount: number;
  quizzesCount: number;
}

/**
 * Firestoreバッチ書き込みを500件ごとに分割して実行する
 * @param db Firestoreインスタンス
 * @param operations 書き込み操作の配列
 */
async function commitInBatches(
  db: Firestore,
  operations: Array<{ ref: DocumentReference; data: Record<string, unknown> }>,
): Promise<void> {
  const BATCH_SIZE = 500;
  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const chunk = operations.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const op of chunk) {
      batch.set(op.ref, op.data);
    }
    await batch.commit();
  }
}

/**
 * マスターコースを対象テナントにディープコピーする
 *
 * マスターテナント（_master）のコース・レッスン・動画・テストを
 * 新しいドキュメントIDで対象テナントにコピーする。
 * GCSパスは共有のためそのまま保持する。
 *
 * @param db Firestoreインスタンス
 * @param masterCourseId マスターコースID
 * @param targetTenantId 配布先テナントID
 * @param distributedBy 配布実行者のユーザーID
 * @returns 配布結果
 */
export async function distributeCourseToTenant(
  db: Firestore,
  masterCourseId: string,
  targetTenantId: string,
  distributedBy: string,
  options: { force?: boolean } = {},
): Promise<DistributionResult> {
  const errorResult = (reason: string): DistributionResult => ({
    tenantId: targetTenantId,
    courseId: "",
    masterCourseId,
    status: "error",
    reason,
    lessonsCount: 0,
    videosCount: 0,
    quizzesCount: 0,
  });

  // 1. マスターテナントからソースデータを読み取る
  const masterDs = new FirestoreDataSource(db, "_master");
  let masterCourse: Course | null;
  try {
    masterCourse = await masterDs.getCourseById(masterCourseId);
  } catch (e) {
    return errorResult(
      `マスターコースの取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!masterCourse) {
    return errorResult(
      `マスターコースが見つかりません: ${masterCourseId}`,
    );
  }

  // 2. 対象テナントに既に配布済みか確認
  let existingSnap;
  try {
    existingSnap = await db
      .collection(`tenants/${targetTenantId}/courses`)
      .where("sourceMasterCourseId", "==", masterCourseId)
      .limit(1)
      .get();
  } catch (e) {
    return errorResult(
      `配布済みチェックに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!existingSnap.empty) {
    if (!options.force) {
      return {
        tenantId: targetTenantId,
        courseId: existingSnap.docs[0].id,
        masterCourseId,
        status: "skipped",
        reason: "already distributed",
        lessonsCount: 0,
        videosCount: 0,
        quizzesCount: 0,
      };
    }

    // force=true: 既存の配信済みデータを削除して再配信
    const existingCourseId = existingSnap.docs[0].id;
    const targetDs = new FirestoreDataSource(db, targetTenantId);
    const [existingLessons, existingVideos, existingQuizzes] = await Promise.all([
      targetDs.getLessons({ courseId: existingCourseId }),
      targetDs.getVideos({ courseId: existingCourseId }),
      targetDs.getQuizzes({ courseId: existingCourseId }),
    ]);
    await Promise.all([
      ...existingVideos.map((v) => targetDs.deleteVideo(v.id)),
      ...existingQuizzes.map((q) => targetDs.deleteQuiz(q.id)),
      ...existingLessons.map((l) => targetDs.deleteLesson(l.id)),
    ]);
    await targetDs.deleteCourse(existingCourseId);
  }

  // 3. マスターテナントから関連データを取得
  const [lessons, videos, quizzes] = await Promise.all([
    masterDs.getLessons({ courseId: masterCourseId }),
    masterDs.getVideos({ courseId: masterCourseId }),
    masterDs.getQuizzes({ courseId: masterCourseId }),
  ]);

  // 4. 新しいドキュメントIDを生成し、IDマッピングを構築
  const targetBasePath = `tenants/${targetTenantId}`;
  const newCourseRef = db.collection(`${targetBasePath}/courses`).doc();
  const newCourseId = newCourseRef.id;

  const lessonIdMap = new Map<string, string>();
  const lessonRefs = new Map<string, DocumentReference>();
  for (const lesson of lessons) {
    const ref = db.collection(`${targetBasePath}/lessons`).doc();
    lessonIdMap.set(lesson.id, ref.id);
    lessonRefs.set(lesson.id, ref);
  }

  // 5. 書き込み操作を準備
  const operations: Array<{
    ref: DocumentReference;
    data: Record<string, unknown>;
  }> = [];

  // コースドキュメント
  const newLessonOrder = (masterCourse.lessonOrder ?? []).map(
    (oldId) => lessonIdMap.get(oldId) ?? oldId,
  );

  operations.push({
    ref: newCourseRef,
    data: {
      name: masterCourse.name,
      description: masterCourse.description ?? null,
      status: "draft",
      lessonOrder: newLessonOrder,
      passThreshold: masterCourse.passThreshold,
      createdBy: distributedBy,
      sourceMasterCourseId: masterCourseId,
      copiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  // レッスンドキュメント
  for (const lesson of lessons) {
    const ref = lessonRefs.get(lesson.id)!;
    operations.push({
      ref,
      data: {
        courseId: newCourseId,
        title: lesson.title,
        order: lesson.order,
        hasVideo: lesson.hasVideo,
        hasQuiz: lesson.hasQuiz,
        videoUnlocksPrior: lesson.videoUnlocksPrior,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  // 動画ドキュメント（gcsPathはGCSファイル共有のためそのまま保持）
  for (const video of videos) {
    const newLessonId = lessonIdMap.get(video.lessonId);
    if (!newLessonId) continue;

    const ref = db.collection(`${targetBasePath}/videos`).doc();
    operations.push({
      ref,
      data: {
        lessonId: newLessonId,
        courseId: newCourseId,
        sourceType: video.sourceType,
        sourceUrl: video.sourceUrl ?? null,
        gcsPath: video.gcsPath ?? null,
        durationSec: video.durationSec,
        requiredWatchRatio: video.requiredWatchRatio,
        speedLock: video.speedLock,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  // テストドキュメント
  for (const quiz of quizzes) {
    const newLessonId = lessonIdMap.get(quiz.lessonId);
    if (!newLessonId) continue;

    const ref = db.collection(`${targetBasePath}/quizzes`).doc();
    operations.push({
      ref,
      data: {
        lessonId: newLessonId,
        courseId: newCourseId,
        title: quiz.title,
        passThreshold: quiz.passThreshold,
        maxAttempts: quiz.maxAttempts,
        timeLimitSec: quiz.timeLimitSec ?? null,
        randomizeQuestions: quiz.randomizeQuestions,
        randomizeAnswers: quiz.randomizeAnswers,
        requireVideoCompletion: quiz.requireVideoCompletion,
        questions: quiz.questions,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  // 6. バッチ書き込み実行
  try {
    await commitInBatches(db, operations);
  } catch (e) {
    return errorResult(
      `Firestore書き込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    tenantId: targetTenantId,
    courseId: newCourseId,
    masterCourseId,
    status: "success",
    lessonsCount: lessons.length,
    videosCount: videos.filter((v: Video) => lessonIdMap.has(v.lessonId)).length,
    quizzesCount: quizzes.filter((q: Quiz) => lessonIdMap.has(q.lessonId)).length,
  };
}
