/**
 * ヘルプページ用ロール判定API
 * テナントコンテキスト外でユーザーのヘルプアクセスレベルを返す
 */

import { Router, type Request, type Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { isSuperAdmin } from "../middleware/super-admin.js";
import { logger } from "../utils/logger.js";

export type HelpLevel = "student" | "admin" | "super";

const router = Router();

const authMode = process.env.AUTH_MODE ?? "dev";

/**
 * GET /api/v2/help/role
 * Firebase IDトークンからヘルプアクセスレベルを判定
 */
router.get("/role", async (req: Request, res: Response) => {
  try {
    let email: string | undefined;

    if (authMode === "firebase") {
      const authHeader = req.header("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        res.json({ helpLevel: "student" as HelpLevel });
        return;
      }
      const idToken = authHeader.slice(7);
      // Issue #294 / ADR-031 境界統一:
      //   - checkRevoked=true で revoke 後の既発行トークンも拒否
      //   - email_verified=true と sign_in_provider=google.com を必須化し、
      //     不適合なら super/admin 昇格を許さず "student" フォールバックする
      //     （ヘルプ画面自体は閲覧可能にして UX 劣化を避ける）
      //   - reason は email_not_verified / non_google_provider で区別し、
      //     外側 catch の "help_role_fallback_error"（Firestore 例外等）と
      //     errorType で切り分け可能にする（Cloud Logging 検索・集計用）。
      const decoded = await getAuth().verifyIdToken(idToken, true);
      if (decoded.email_verified !== true) {
        logger.warn("Help role guard failed", {
          errorType: "help_role_guard_failed",
          reason: "email_not_verified",
          uid: decoded.uid,
        });
        res.json({ helpLevel: "student" as HelpLevel });
        return;
      }
      if (decoded.firebase?.sign_in_provider !== "google.com") {
        logger.warn("Help role guard failed", {
          errorType: "help_role_guard_failed",
          reason: "non_google_provider",
          uid: decoded.uid,
          signInProvider: decoded.firebase?.sign_in_provider ?? null,
        });
        res.json({ helpLevel: "student" as HelpLevel });
        return;
      }
      email = decoded.email;
    } else {
      // 開発モード: X-User-Emailヘッダを使用
      email = req.header("x-user-email");
    }

    if (!email) {
      res.json({ helpLevel: "student" as HelpLevel });
      return;
    }

    // スーパー管理者チェック
    const superAdmin = await isSuperAdmin(email);
    if (superAdmin) {
      res.json({ helpLevel: "super" as HelpLevel });
      return;
    }

    // 全テナントでの最高ロールを検索
    const highestRole = await findHighestRoleAcrossTenants(email);
    const helpLevel: HelpLevel =
      highestRole === "admin" || highestRole === "teacher" ? "admin" : "student";

    res.json({ helpLevel });
  } catch (error) {
    // Issue #294: 意図的な guard フォールバック (errorType=help_role_guard_failed) と
    // 区別するため、想定外の例外（Firestore 障害 / verifyIdToken の auth/internal-error 等）
    // は errorType=help_role_fallback_error で構造化ログに残す。
    // レスポンス形状は UX 維持のため student で揃えるが、Cloud Logging 上では分離できる。
    const err = error as { code?: unknown };
    logger.error("Help role fallback due to unexpected error", {
      errorType: "help_role_fallback_error",
      firebaseErrorCode: typeof err.code === "string" ? err.code : null,
      error: error instanceof Error ? error.message : String(error),
    });
    res.json({ helpLevel: "student" as HelpLevel });
  }
});

/**
 * 全テナントを横断してユーザーの最高ロールを取得
 */
async function findHighestRoleAcrossTenants(
  email: string
): Promise<"admin" | "teacher" | "student"> {
  const db = getFirestore();
  const tenantsSnapshot = await db.collection("tenants").get();

  const roleRank: Record<string, number> = {
    admin: 3,
    teacher: 2,
    student: 1,
  };

  let highestRole: "admin" | "teacher" | "student" = "student";

  for (const tenantDoc of tenantsSnapshot.docs) {
    const usersSnapshot = await db
      .collection(`tenants/${tenantDoc.id}/users`)
      .where("email", "==", email.toLowerCase())
      .limit(1)
      .get();

    if (!usersSnapshot.empty) {
      const userRole = usersSnapshot.docs[0].data().role as string;
      if ((roleRank[userRole] ?? 0) > roleRank[highestRole]) {
        highestRole = userRole as "admin" | "teacher" | "student";
      }
      // adminなら最高なので早期終了
      if (highestRole === "admin") break;
    }
  }

  return highestRole;
}

export const helpRoleRouter = router;
