import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CredentialNotFoundError,
  type CredentialService,
  type GetFirebaseIdTokenOptions,
} from "./credential-service.js";
import { LmsApiError, type LmsApiClient } from "./lms-api-client.js";
import type { AuditLog } from "./audit-log.js";
import { verifyGoogleIdToken } from "./firebase.js";
import type { TenantMembershipChecker } from "./tenant-membership.js";
import { logger } from "./logger.js";

/**
 * Phase 2a: 読み取り専用quizツール（list_courses/list_lessons/get_quiz）が依存する
 * サービス群。省略時（Phase 0/Phase 1a時点の既存テスト後方互換）は ping のみ登録する。
 * Phase 2b PR C1: tenantMembership/tenantGuardModeを追加（テナント自己一致ガード）。
 */
export interface McpServerDeps {
  lmsApiClient: LmsApiClient;
  credentialService: CredentialService;
  auditLog: AuditLog;
  tenantMembership: TenantMembershipChecker;
  tenantGuardMode: "dry-run" | "enforce";
}

/**
 * テナント自己一致ガード(enforce)によるブロック。計画magical-noodling-duckling.md
 * 「PR C1」節参照。super adminであっても、MCP経由ではallowed_emails未登録の
 * テナントを操作できない（Web管理画面からは従来通り操作可能）。
 */
export class TenantAccessDeniedError extends Error {
  constructor(readonly tenant: string) {
    super(`テナント「${tenant}」はあなたのアカウントに割り当てられていません。Web管理画面をご利用ください。`);
    this.name = "TenantAccessDeniedError";
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** @internal テスト用にexport（token-verifier.tsが常にaccountIdを設定するため通常到達しない不変条件チェックの検証用） */
export function extractUid(ctx: ServerContext): string | undefined {
  const accountId = ctx.http?.authInfo?.extra?.accountId;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

/**
 * credentialServiceからのIDトークン取得を、失敗時も監査ログに残すラッパー。
 * 初回取得・401リトライ時のforceRefresh取得のどちらも同じ関数を通す
 * （codex review P2指摘: 従来はtry/catchの外で呼んでいたため、資格情報の
 * 取得自体が失敗したケースが監査ログから漏れていた）。
 */
async function getIdTokenAudited(
  deps: McpServerDeps,
  uid: string,
  tenant: string,
  tool: string,
  targetId: string | undefined,
  options?: GetFirebaseIdTokenOptions
): Promise<string> {
  try {
    return await deps.credentialService.getFirebaseIdTokenForAccount(uid, options);
  } catch (error) {
    await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "error" });
    throw error;
  }
}

/**
 * テナント自己一致ガード。実際にAPI呼び出しに使うidTokenからemailを解決し、
 * tenants/{tenant}/allowed_emails への所属を確認する。401リトライ時の
 * forceRefreshで取得し直したidTokenについても、この関数を呼び出し元で
 * 毎回再実行することで再検証する（1回目の検証だけだとリトライ経路がガード外に
 * なる問題をCodexセカンドオピニオンで指摘されたため）。
 *
 * enforceモードで未所属ならブロックしTenantAccessDeniedErrorを投げる
 * （呼び出し元でこの関数自体を try/catch の外に置き、fn()呼び出し前に
 * 例外を伝播させることでAPIへ到達させない）。dry-runモードでは記録のみ。
 */
async function verifyTenantMembershipAudited(
  deps: McpServerDeps,
  uid: string,
  tenant: string,
  tool: string,
  targetId: string | undefined,
  idToken: string
): Promise<void> {
  const account = await verifyGoogleIdToken(idToken);
  const membership = await deps.tenantMembership.checkMembership(tenant, account.email);
  if (membership === "member") {
    return;
  }
  if (deps.tenantGuardMode === "enforce") {
    await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "denied" });
    throw new TenantAccessDeniedError(tenant);
  }
  await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "would_deny" });
}

/**
 * アクセストークンからuidを取得 → credentialServiceでFirebase IDトークンを取得 →
 * テナント自己一致ガードを検証 → fnを実行 → 結果に応じて監査ログを記録する。
 * LMS APIが401を返した場合のみ、forceRefreshで新規exchangeしたIDトークンで
 * 1回だけリトライする（ID交換のタイミング起因のclock skew等を想定。
 * 計画linear-zooming-conway.md「PR B」節参照）。
 */
async function callToolWithAuth<T>(
  deps: McpServerDeps,
  ctx: ServerContext,
  tool: string,
  tenant: string,
  targetId: string | undefined,
  fn: (idToken: string) => Promise<T>
): Promise<T> {
  const uid = extractUid(ctx);
  if (!uid) {
    // accountIdはtoken-verifier.tsが検証済みトークンのsubから必ず設定するため、
    // 通常到達しない不変条件違反経路。到達した場合も監査ログの空白を残さない
    // （silent-failure-hunterセカンドオピニオン指摘: この一手だけ監査ログが漏れていた）。
    await deps.auditLog.record({ actor: "unknown", tenant, tool, targetId, result: "error" });
    throw new Error("認証情報からユーザーIDを取得できませんでした");
  }

  const idToken = await getIdTokenAudited(deps, uid, tenant, tool, targetId);
  await verifyTenantMembershipAudited(deps, uid, tenant, tool, targetId, idToken);
  try {
    const result = await fn(idToken);
    await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "success" });
    return result;
  } catch (error) {
    if (error instanceof LmsApiError && error.httpStatus === 401) {
      const retriedIdToken = await getIdTokenAudited(deps, uid, tenant, tool, targetId, { forceRefresh: true });
      await verifyTenantMembershipAudited(deps, uid, tenant, tool, targetId, retriedIdToken);
      try {
        const result = await fn(retriedIdToken);
        await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "success" });
        return result;
      } catch (retryError) {
        await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "error" });
        throw retryError;
      }
    }
    await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "error" });
    throw error;
  }
}

function mapErrorToResult(tool: string, error: unknown): CallToolResult {
  if (error instanceof CredentialNotFoundError) {
    return errorResult("再認証が必要です。改めてサインインしてください。");
  }
  if (error instanceof TenantAccessDeniedError) {
    return errorResult(error.message);
  }
  if (error instanceof LmsApiError) {
    if (error.transient) {
      // transient(ネットワーク例外・5xx)の error.message は fetch/AbortSignal.timeout
      // が投げた生の例外文字列を含みうる(接続先ホスト名等の内部詳細が漏れる可能性)。
      // get_quizの応答同様MCPクライアントの先はAnthropicのクラウド基盤を経由するため、
      // 詳細はサーバー側ログにのみ残し、クライアントへは汎用メッセージのみ返す
      // （silent-failure-hunterセカンドオピニオン指摘）。
      logger.error(`${tool}: LMS API呼び出しが一時的に失敗しました`, { error: error.message });
      return errorResult("LMS APIへの接続に一時的に失敗しました。しばらくしてから再度お試しください。");
    }
    return errorResult(`LMS APIの呼び出しに失敗しました: ${error.message}`);
  }
  logger.error(`${tool} failed`, { error: String(error) });
  return errorResult("予期しないエラーが発生しました。");
}

export function createMcpServer(deps?: McpServerDeps): McpServer {
  const server = new McpServer({ name: "lms-quiz-mcp", version: "0.1.0-phase2a" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Phase 0 疎通確認用。固定文字列を返すだけ。",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    })
  );

  if (!deps) {
    return server;
  }

  server.registerTool(
    "list_courses",
    {
      title: "List Courses",
      description: "指定テナントの講座一覧を取得します。tenant引数は必須です。",
      inputSchema: z.object({ tenant: z.string() }),
    },
    async ({ tenant }, ctx): Promise<CallToolResult> => {
      try {
        const courses = await callToolWithAuth(deps, ctx, "list_courses", tenant, undefined, (idToken) =>
          deps.lmsApiClient.listCourses(tenant, idToken)
        );
        return textResult({ courses });
      } catch (error) {
        return mapErrorToResult("list_courses", error);
      }
    }
  );

  server.registerTool(
    "list_lessons",
    {
      title: "List Lessons",
      description: "指定講座配下のレッスン一覧を取得します（テストの有無 hasQuiz を含む）。",
      inputSchema: z.object({ tenant: z.string(), courseId: z.string() }),
    },
    async ({ tenant, courseId }, ctx): Promise<CallToolResult> => {
      try {
        const lessons = await callToolWithAuth(deps, ctx, "list_lessons", tenant, courseId, (idToken) =>
          deps.lmsApiClient.listLessons(tenant, courseId, idToken)
        );
        return textResult({ lessons });
      } catch (error) {
        return mapErrorToResult("list_lessons", error);
      }
    }
  );

  server.registerTool(
    "get_quiz",
    {
      title: "Get Quiz",
      description:
        "指定レッスンのテスト内容を取得します。正解・解説を含む全情報が返り、この内容はAnthropicのクラウド基盤を経由します。取り扱いに注意してください。",
      inputSchema: z.object({ tenant: z.string(), lessonId: z.string() }),
    },
    async ({ tenant, lessonId }, ctx): Promise<CallToolResult> => {
      try {
        const quiz = await callToolWithAuth(deps, ctx, "get_quiz", tenant, lessonId, (idToken) =>
          deps.lmsApiClient.getQuiz(tenant, lessonId, idToken)
        );
        return textResult({ quiz });
      } catch (error) {
        return mapErrorToResult("get_quiz", error);
      }
    }
  );

  return server;
}
