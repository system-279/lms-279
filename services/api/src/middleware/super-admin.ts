/**
 * スーパー管理者認可ミドルウェア
 * Firestoreまたは環境変数で指定されたメールアドレスのみアクセスを許可
 */

import type { Request, Response, NextFunction } from "express";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const authMode = process.env.AUTH_MODE ?? "dev";

// 環境変数からのスーパー管理者（フォールバック/ブートストラップ用）
const envSuperAdminEmails: string[] = (process.env.SUPER_ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter((email) => email.length > 0);

// Firebase Admin SDK初期化（firebase モードの場合のみ、未初期化の場合）
if (authMode === "firebase" && getApps().length === 0) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      projectId,
    });
  } else {
    initializeApp({ projectId });
  }
}

/**
 * スーパー管理者情報をリクエストに付与するための型拡張
 */
export interface SuperAdminUser {
  email: string;
  firebaseUid?: string;
}

declare global {
  namespace Express {
    interface Request {
      superAdmin?: SuperAdminUser;
    }
  }
}

/**
 * Firestoreからスーパー管理者一覧を取得
 */
export async function getSuperAdminsFromFirestore(): Promise<string[]> {
  try {
    const db = getFirestore();
    const snapshot = await db.collection("superAdmins").get();
    return snapshot.docs.map((doc) => doc.id.toLowerCase());
  } catch (error) {
    console.error("Failed to fetch super admins from Firestore:", error);
    return [];
  }
}

/**
 * メールアドレスがスーパー管理者か判定（環境変数 + Firestore両方チェック）
 */
export async function isSuperAdmin(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  const normalizedEmail = email.toLowerCase();

  // 環境変数でチェック（高速パス）
  if (envSuperAdminEmails.includes(normalizedEmail)) {
    return true;
  }

  // Firestoreでチェック
  const firestoreAdmins = await getSuperAdminsFromFirestore();
  return firestoreAdmins.includes(normalizedEmail);
}

/**
 * スーパー管理者をFirestoreに追加
 */
export async function addSuperAdmin(email: string, addedBy: string): Promise<void> {
  const db = getFirestore();
  const normalizedEmail = email.toLowerCase();
  await db.collection("superAdmins").doc(normalizedEmail).set({
    email: normalizedEmail,
    addedBy,
    addedAt: new Date().toISOString(),
  });
  console.log(`Super admin added: ${normalizedEmail} by ${addedBy}`);
}

/**
 * スーパー管理者をFirestoreから削除
 */
export async function removeSuperAdmin(email: string): Promise<void> {
  const db = getFirestore();
  const normalizedEmail = email.toLowerCase();
  await db.collection("superAdmins").doc(normalizedEmail).delete();
  console.log(`Super admin removed: ${normalizedEmail}`);
}

/**
 * 全スーパー管理者一覧を取得（環境変数 + Firestore）
 */
export async function getAllSuperAdmins(): Promise<Array<{
  email: string;
  source: "env" | "firestore";
  addedAt?: string;
  addedBy?: string;
}>> {
  const result: Array<{
    email: string;
    source: "env" | "firestore";
    addedAt?: string;
    addedBy?: string;
  }> = [];

  // 環境変数からの管理者
  for (const email of envSuperAdminEmails) {
    result.push({ email, source: "env" });
  }

  // Firestoreからの管理者
  try {
    const db = getFirestore();
    const snapshot = await db.collection("superAdmins").get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      // 環境変数と重複していない場合のみ追加
      if (!envSuperAdminEmails.includes(doc.id)) {
        result.push({
          email: doc.id,
          source: "firestore",
          addedAt: data.addedAt,
          addedBy: data.addedBy,
        });
      }
    }
  } catch (error) {
    console.error("Failed to fetch super admins from Firestore:", error);
  }

  return result;
}

/**
 * スーパー管理者認可ミドルウェア
 * Firebase認証後、メールアドレスがスーパー管理者かチェック
 */
export const superAdminAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (authMode === "dev") {
    // 開発モード: X-User-Email ヘッダでスーパー管理者判定
    const headerEmail = req.header("x-user-email");

    if (!headerEmail) {
      return res.status(401).json({
        error: "unauthorized",
        message: "認証情報がありません",
      });
    }

    const isAdmin = await isSuperAdmin(headerEmail);
    if (!isAdmin) {
      return res.status(403).json({
        error: "forbidden",
        message: "スーパー管理者権限が必要です",
      });
    }

    req.superAdmin = { email: headerEmail.toLowerCase() };
    return next();
  }

  if (authMode === "firebase") {
    // Firebase認証: Authorization: Bearer <ID Token>
    const authHeader = req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "unauthorized",
        message: "認証情報がありません",
      });
    }

    const idToken = authHeader.slice(7);
    try {
      const decodedToken = await getAuth().verifyIdToken(idToken);
      const email = decodedToken.email;

      const isAdmin = await isSuperAdmin(email);
      if (!isAdmin) {
        return res.status(403).json({
          error: "forbidden",
          message: "スーパー管理者権限が必要です",
        });
      }

      req.superAdmin = {
        email: email!.toLowerCase(),
        firebaseUid: decodedToken.uid,
      };
      return next();
    } catch (error) {
      console.error("Firebase token verification failed:", error);
      return res.status(401).json({
        error: "unauthorized",
        message: "認証に失敗しました",
      });
    }
  }

  // 不明なAUTH_MODEの場合
  return res.status(500).json({
    error: "internal_error",
    message: "不明な認証モードです",
  });
};
