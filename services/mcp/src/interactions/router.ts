import { Router } from "express";
import type Provider from "oidc-provider";
import { errors } from "oidc-provider";
import { verifyGoogleIdToken, FirebaseSignInError } from "../firebase.js";
import { renderLoginPage, renderConsentPage, renderErrorPage, type FirebaseWebConfig } from "./views.js";
import type { CredentialStore } from "../storage/credential-store.js";
import { encryptWithActiveKey, type CredentialKeyring } from "../credential-keys.js";
import { logger } from "../logger.js";

export interface CredentialOptions {
  store: CredentialStore;
  keyring: CredentialKeyring;
  /** 既定3000ms。Firestore劣化時にサインイン応答が無期限にブロックされないための上限（codex review指摘） */
  persistTimeoutMs?: number;
}

const DEFAULT_PERSIST_TIMEOUT_MS = 3000;

/**
 * サインイン時に捕捉した Firebase リフレッシュトークンを暗号化して永続化する。
 * 保存失敗はサインイン成功を阻害しない（ping 等トークンを使わない機能は
 * 引き続き動作すべきため、rules/error-handling.md §1の独立防御パターンに準拠）。
 *
 * 書き込みは persistTimeoutMs で上限を設ける。Firestoreが劣化しリトライを
 * 繰り返している間、awaitしたままだとサインイン応答自体が無期限にブロックされ
 * 「保存失敗はサインインを阻害しない」という設計意図に反する（codex review
 * 指摘、2026-08-23）。タイムアウト後も書き込み自体はバックグラウンドで継続し
 * (自身のtry/catchで保護済みのためunhandled rejectionにはならない)、完了すれば
 * 通常どおり永続化される。
 */
async function persistRefreshTokenBestEffort(
  credentialOptions: CredentialOptions | undefined,
  uid: string,
  refreshToken: unknown
): Promise<void> {
  if (!credentialOptions || typeof refreshToken !== "string" || refreshToken.length === 0) {
    return;
  }
  const { store, keyring, persistTimeoutMs = DEFAULT_PERSIST_TIMEOUT_MS } = credentialOptions;

  const writePromise = (async () => {
    try {
      const encrypted = encryptWithActiveKey(refreshToken, keyring);
      await store.save(uid, { encryptedRefreshToken: encrypted, keyVersion: keyring.activeVersion });
    } catch (error) {
      logger.error("Failed to persist Firebase refresh token", { error: String(error) });
    }
  })();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      logger.error("Persisting Firebase refresh token exceeded timeout; continuing sign-in without waiting", {
        uid,
        persistTimeoutMs,
      });
      resolve();
    }, persistTimeoutMs);
    timeoutHandle.unref();
  });

  await Promise.race([writePromise, timeoutPromise]);
  // writePromise が先に解決した場合、タイマーを止めないと persistTimeoutMs 後に
  // 「タイムアウトした」という偽のログが遅延発火する（codex review再指摘、2026-08-23）。
  clearTimeout(timeoutHandle);
}

/**
 * devInteractions（oidc-provider 組み込みのダミー同意画面）を置き換える、実
 * Firebase Google サインイン + 同意画面。`interactionResult`（res に触れず
 * returnTo を返すだけ）を使い、ページ側の JS が fetch() で JSON POST してから
 * `location.assign(redirectTo)` で遷移する（interactionFinished は res に直接
 * 303 を書き込む生 HTTP 前提の実装のため、fetch ベースのフローには使えない。
 * node_modules/oidc-provider/lib/provider.js:211-236 で確認済み）。
 *
 * app.ts で `app.use(provider.callback())`（catch-all）より前に登録すること。
 */
export function createInteractionRouter(
  provider: Provider,
  firebaseConfig: FirebaseWebConfig,
  credentialOptions?: CredentialOptions
): Router {
  const router = Router();

  router.get("/interaction/:uid", async (req, res, next) => {
    try {
      const { uid, prompt, params } = await provider.interactionDetails(req, res);
      if (prompt.name === "login") {
        res.set("Content-Type", "text/html; charset=utf-8").send(renderLoginPage({ uid, firebaseConfig }));
        return;
      }
      if (prompt.name === "consent") {
        const clientId = params.client_id;
        const client = typeof clientId === "string" ? await provider.Client.find(clientId) : undefined;
        const clientName = client?.clientName ?? (typeof clientId === "string" ? clientId : "unknown client");
        const redirectUri = typeof params.redirect_uri === "string" ? params.redirect_uri : "";
        const scopes = typeof params.scope === "string" ? params.scope.split(" ").filter(Boolean) : [];
        res
          .set("Content-Type", "text/html; charset=utf-8")
          .send(renderConsentPage({ uid, clientName, redirectUri, scopes }));
        return;
      }
      res.status(501).set("Content-Type", "text/html; charset=utf-8").send(renderErrorPage("未対応の interaction です"));
    } catch (err) {
      if (err instanceof errors.SessionNotFound) {
        // Cloud Run インスタンス再起動等でインメモリの interaction session が
        // 失われた場合に発生しうる、想定内のエラー(oidc.ts のPhase 1a PR2に
        // 関するコメント参照。PR2で永続adapterに置き換えるまでは起こりうる)。
        // 汎用エラーハンドラへ落とさずここで案内する。
        res
          .status(400)
          .set("Content-Type", "text/html; charset=utf-8")
          .send(renderErrorPage("サインインセッションの有効期限が切れました。もう一度やり直してください。"));
        return;
      }
      next(err);
    }
  });

  router.post("/interaction/:uid/firebase-callback", async (req, res, next) => {
    try {
      const idToken = (req.body as Record<string, unknown> | undefined)?.idToken;
      if (typeof idToken !== "string" || idToken.length === 0) {
        res.status(400).json({ error: "idToken is required" });
        return;
      }
      const account = await verifyGoogleIdToken(idToken);
      const refreshToken = (req.body as Record<string, unknown> | undefined)?.refreshToken;
      await persistRefreshTokenBestEffort(credentialOptions, account.uid, refreshToken);
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { login: { accountId: account.uid } },
        { mergeWithLastSubmission: false }
      );
      res.json({ redirectTo });
    } catch (err) {
      if (err instanceof FirebaseSignInError) {
        res.status(err.transient ? 503 : 403).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.post("/interaction/:uid/confirm", async (req, res, next) => {
    try {
      const {
        prompt: { name, details },
        grantId,
        session,
        params,
      } = await provider.interactionDetails(req, res);

      if (name !== "consent") {
        res.status(400).json({ error: "not a consent interaction" });
        return;
      }

      const grant = grantId
        ? await provider.Grant.find(grantId)
        : new provider.Grant({
            accountId: session?.accountId,
            clientId: typeof params.client_id === "string" ? params.client_id : undefined,
          });

      if (!grant) {
        res.status(400).json({ error: "grant not found" });
        return;
      }

      const missingOIDCScope = details.missingOIDCScope;
      if (missingOIDCScope instanceof Set || Array.isArray(missingOIDCScope)) {
        // offline_access は明示的に除外する（DCR登録クライアントが要求しても長期
        // refresh token を発行しない。計画ファイル「offline_access を付与しない」節）。
        const scopes = [...missingOIDCScope].filter((s) => s !== "offline_access");
        if (scopes.length > 0) {
          grant.addOIDCScope(scopes);
        }
      }

      const missingOIDCClaims = details.missingOIDCClaims;
      if (missingOIDCClaims instanceof Set || Array.isArray(missingOIDCClaims)) {
        grant.addOIDCClaims([...missingOIDCClaims]);
      }

      const missingResourceScopes = details.missingResourceScopes;
      if (missingResourceScopes && typeof missingResourceScopes === "object") {
        for (const [indicator, scope] of Object.entries(missingResourceScopes as Record<string, string[]>)) {
          grant.addResourceScope(indicator, scope);
        }
      }

      const savedGrantId = await grant.save();
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { consent: { grantId: savedGrantId } },
        { mergeWithLastSubmission: true }
      );
      res.json({ redirectTo });
    } catch (err) {
      next(err);
    }
  });

  router.post("/interaction/:uid/abort", async (req, res, next) => {
    try {
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { error: "access_denied", error_description: "サインインまたは同意がキャンセルされました" },
        { mergeWithLastSubmission: false }
      );
      res.json({ redirectTo });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
