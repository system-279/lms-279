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

/**
 * テナント自己一致ガードのID検証（verifyGoogleIdToken）自体が失敗した場合の
 * enforceモードでのブロック。tenant-membership.ts の Firestoreクエリ失敗時と
 * 同じfail-closed方針（pr-review-toolkit:code-reviewerセカンドオピニオン指摘:
 * 「無効なidTokenなら別途401で弾かれる」という当初の安全性根拠は誤りで、
 * verifyGoogleIdTokenの失敗はidToken自体の無効性を意味しない — Admin SDK側の
 * 一時的な不調等でも起こりうり、その場合idTokenは有効なままfn()は普通に成功する。
 * 判定不能を理由にsuper adminのテナント横断アクセスだけ素通りさせるのは、
 * 他の一般ユーザーがFirestore障害時にfail-closedされるのと非対称になる）。
 */
export class TenantMembershipVerificationError extends Error {
  constructor() {
    super("本人確認に失敗しました。しばらくしてから再度お試しください。");
    this.name = "TenantMembershipVerificationError";
  }
}

/**
 * Phase 2b PR C2: update_quiz/delete_quizの同時編集検知（expectedUpdatedAt不一致）。
 * services/api非改変の制約により真の楽観ロックではなく、実行直前GETとの差分検知に
 * 留まる（計画magical-noodling-duckling.md「PR C2」節参照。GETと書き込みの間の
 * ごく短い競合、同一ミリ秒内の複数更新までは検知できない）。
 */
export class QuizConcurrencyError extends Error {
  constructor(readonly actualUpdatedAt: string) {
    super(
      `テストの内容が最後に確認した時点から変更されています。get_quizで最新のupdatedAt（${actualUpdatedAt}）を確認し、expectedUpdatedAtに指定して再実行してください。`
    );
    this.name = "QuizConcurrencyError";
  }
}

/** delete_quizのconfirmTitleが実際のタイトルと一致しない場合のブロック。 */
export class QuizDeleteConfirmationError extends Error {
  constructor(readonly actualTitle: string) {
    super(`確認のため、confirmTitleには削除対象のテストの実際のタイトル（現在: 「${actualTitle}」）を指定してください。`);
    this.name = "QuizDeleteConfirmationError";
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
 *
 * verifyGoogleIdToken自体が失敗した場合（clock skew等での検証エラー、Admin SDK
 * 側の一時的な不調等）は「テナント不一致」とは別種の判定不能。dry-runモードでは
 * 「絶対にブロックしない」という契約を守り記録のみに留めるが、enforceモードでは
 * tenant-membership.tsのFirestoreクエリ失敗時と同じfail-closed方針を取り、
 * TenantMembershipVerificationErrorでブロックする（元実装はここでfail-openにして
 * いたが、pr-review-toolkit:code-reviewerセカンドオピニオンで「まさにガードが
 * 機能してほしい瞬間に無効化される」と指摘され修正）。
 * いずれのモードでも監査ログには残す（silent-failure-hunterセカンドオピニオン指摘:
 * 元実装は例外がtry/catchなく伝播し監査ログから漏れていた）。
 */
async function verifyTenantMembershipAudited(
  deps: McpServerDeps,
  uid: string,
  tenant: string,
  tool: string,
  targetId: string | undefined,
  idToken: string
): Promise<void> {
  let email: string;
  try {
    email = (await verifyGoogleIdToken(idToken)).email;
  } catch (error) {
    logger.error(`${tool}: テナント自己一致ガードのID検証に失敗しました`, {
      tenant,
      tenantGuardMode: deps.tenantGuardMode,
      error: String(error),
    });
    await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "error" });
    if (deps.tenantGuardMode === "enforce") {
      throw new TenantMembershipVerificationError();
    }
    return;
  }
  const membership = await deps.tenantMembership.checkMembership(tenant, email);
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
      // 初回401失敗そのものを記録する（PR #667レビュー指摘: リトライ成功時に
      // 成功ログ1件のみが残り、初回の認可エラーが監査ログから読み取れなかった）。
      await deps.auditLog.record({ actor: uid, tenant, tool, targetId, result: "error" });
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
  if (
    error instanceof TenantAccessDeniedError ||
    error instanceof TenantMembershipVerificationError ||
    error instanceof QuizConcurrencyError ||
    error instanceof QuizDeleteConfirmationError
  ) {
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
      // create_quiz/delete_quizはquiz本体の書き込み+lesson.hasQuiz更新の非トランザクション
      // 2段書き込み（services/api側、非改変の制約により修正不可）。後段のみ失敗しても
      // このtransient分岐に落ちるため、「一時的失敗・再試行可能」という汎用文言のままでは
      // 実際には既に完了している破壊的操作（作成/物理削除）を安全な再試行対象と誤読させる
      // （silent-failure-hunterセカンドオピニオン2巡目指摘・CRITICAL）。
      if (tool === "create_quiz" || tool === "delete_quiz") {
        return errorResult(
          "LMS APIとの通信でエラーが発生しました。このエラーだけでは、テスト自体の作成/削除処理が完了しているかどうかを判別できません。同じ操作を再試行する前に、必ずget_quizで現在の状態を確認してください。"
        );
      }
      return errorResult("LMS APIへの接続に一時的に失敗しました。しばらくしてから再度お試しください。");
    }
    return errorResult(`LMS APIの呼び出しに失敗しました: ${error.message}`);
  }
  logger.error(`${tool} failed`, { error: String(error) });
  return errorResult("予期しないエラーが発生しました。");
}

/**
 * tenant引数の形式チェック。API側 validateTenantId（services/api/src/middleware/
 * tenant.ts:26-27,33-50）と同じ正規表現・長さ制約・予約ID拒否を、MCP側でも
 * 事前に課す。emailの正規化とは異なりtenantはtrim/lowercase等の変換をしない
 * （Firestoreパス生成やAPI側の一致判定と食い違う余地を作らないため）。
 */
const tenantSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "テナントIDの形式が不正です")
  .refine((v) => v !== "_master", { message: "予約されたテナントIDです" });

const quizOptionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  isCorrect: z.boolean(),
});

/**
 * quiz構造・50問上限・single型は正解ちょうど1つ、をMCP側でも表現する。
 * API側 validateQuestions（services/api/src/routes/shared/quizzes.ts:31-91）が
 * 正典であることに変わりはなく、これは即時フィードバック用の事前チェック
 * （二重実装のドリフトを認識した上での意図的な選択、計画「PR C2」節参照）。
 */
const quizQuestionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    type: z.enum(["single", "multi"]),
    options: z.array(quizOptionSchema).min(1),
    points: z.number().min(0),
    explanation: z.string().default(""),
  })
  .refine(
    (q) => q.type !== "single" || q.options.filter((o) => o.isCorrect).length === 1,
    { message: "single型の問題は正解(isCorrect)がちょうど1つである必要があります" }
  );

const questionsSchema = z.array(quizQuestionSchema).min(1).max(50);

/**
 * passThreshold/maxAttempts/timeLimitSecの範囲は、API側が一切バリデーションしない
 * （services/api非改変の制約下でMCP側zodが最後の防波堤。Codexセカンドオピニオン
 * 2巡目指摘: passThresholdに負値を渡すと採点ロジックscore>=passThresholdにより
 * 全員合格になりうる）。
 */
const optionalQuizFieldsShape = {
  passThreshold: z.number().min(0).max(100).optional(),
  maxAttempts: z.number().int().min(0).optional(),
  timeLimitSec: z.number().int().positive().nullable().optional(),
  randomizeQuestions: z.boolean().optional(),
  randomizeAnswers: z.boolean().optional(),
  requireVideoCompletion: z.boolean().optional(),
};

const createQuizSchema = z.object({
  tenant: tenantSchema,
  lessonId: z.string().min(1),
  title: z.string().min(1),
  questions: questionsSchema,
  ...optionalQuizFieldsShape,
});

const updateQuizSchema = z
  .object({
    tenant: tenantSchema,
    lessonId: z.string().min(1),
    expectedUpdatedAt: z.string().min(1),
    title: z.string().min(1).optional(),
    questions: questionsSchema.optional(),
    ...optionalQuizFieldsShape,
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.questions !== undefined ||
      v.passThreshold !== undefined ||
      v.maxAttempts !== undefined ||
      v.timeLimitSec !== undefined ||
      v.randomizeQuestions !== undefined ||
      v.randomizeAnswers !== undefined ||
      v.requireVideoCompletion !== undefined,
    {
      // applyUpdate(services/api/src/datasource/firestore.ts:171-178)は更新
      // フィールドが空でも無条件にupdatedAtを書き込むため、意味のない呼び出しが
      // 他クライアントのexpectedUpdatedAtを失効させてしまう（Codexセカンドオピニオン
      // 2巡目指摘）。
      message: "expectedUpdatedAt以外に少なくとも1つの更新フィールドを指定してください",
    }
  );

const deleteQuizSchema = z.object({
  tenant: tenantSchema,
  lessonId: z.string().min(1),
  expectedUpdatedAt: z.string().min(1),
  confirmTitle: z.string().min(1),
});

/**
 * update_quiz/delete_quizの実行直前GET→差分検知。真の楽観ロックではない
 * （TOCTOUは残存、計画「PR C2」節参照）が、数分〜数時間スパンでの無言の
 * 上書きは検知できる。
 */
async function assertQuizMatchesExpected(
  lmsApiClient: LmsApiClient,
  tenant: string,
  lessonId: string,
  expectedUpdatedAt: string,
  idToken: string
) {
  const quiz = await lmsApiClient.getQuiz(tenant, lessonId, idToken);
  if (quiz.updatedAt !== expectedUpdatedAt) {
    throw new QuizConcurrencyError(quiz.updatedAt);
  }
  return quiz;
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
      inputSchema: z.object({ tenant: tenantSchema }),
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
      inputSchema: z.object({ tenant: tenantSchema, courseId: z.string() }),
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
      inputSchema: z.object({ tenant: tenantSchema, lessonId: z.string() }),
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

  server.registerTool(
    "create_quiz",
    {
      title: "Create Quiz",
      description:
        "指定レッスンに新しいテストを作成します。既にテストが存在する場合はエラーになります。questionsは最大50問、single型の問題は正解(isCorrect)がちょうど1つ必要です。同一レッスンに対してこのツールを短時間に複数回・並行して呼び出すと、API側に排他制御がないため両方成功し同一レッスンに複数のテストが作成されてしまう場合があります（既存チェックと作成の間に排他がないTOCTOU）。同じレッスンへの作成は一度に1回だけ実行してください。",
      inputSchema: createQuizSchema,
    },
    async (
      { tenant, lessonId, title, questions, passThreshold, maxAttempts, timeLimitSec, randomizeQuestions, randomizeAnswers, requireVideoCompletion },
      ctx
    ): Promise<CallToolResult> => {
      try {
        const quiz = await callToolWithAuth(deps, ctx, "create_quiz", tenant, lessonId, (idToken) =>
          deps.lmsApiClient.createQuiz(
            tenant,
            lessonId,
            { title, questions, passThreshold, maxAttempts, timeLimitSec, randomizeQuestions, randomizeAnswers, requireVideoCompletion },
            idToken
          )
        );
        return textResult({ quiz });
      } catch (error) {
        return mapErrorToResult("create_quiz", error);
      }
    }
  );

  server.registerTool(
    "update_quiz",
    {
      title: "Update Quiz",
      description:
        "指定レッスンのテストを更新します。expectedUpdatedAtには直前にget_quizで取得したupdatedAtの値を指定してください（一致しない場合、他の変更と衝突している可能性があるため更新を中止します）。questionsを渡すと配列全体が置換されるため、1問だけ直す場合も全問を送る必要があります。expectedUpdatedAt以外に少なくとも1つの更新フィールドが必要です。",
      inputSchema: updateQuizSchema,
    },
    async (
      { tenant, lessonId, expectedUpdatedAt, title, questions, passThreshold, maxAttempts, timeLimitSec, randomizeQuestions, randomizeAnswers, requireVideoCompletion },
      ctx
    ): Promise<CallToolResult> => {
      try {
        const quiz = await callToolWithAuth(deps, ctx, "update_quiz", tenant, lessonId, async (idToken) => {
          await assertQuizMatchesExpected(deps.lmsApiClient, tenant, lessonId, expectedUpdatedAt, idToken);
          return deps.lmsApiClient.updateQuiz(
            tenant,
            lessonId,
            { title, questions, passThreshold, maxAttempts, timeLimitSec, randomizeQuestions, randomizeAnswers, requireVideoCompletion },
            idToken
          );
        });
        return textResult({ quiz });
      } catch (error) {
        return mapErrorToResult("update_quiz", error);
      }
    }
  );

  server.registerTool(
    "delete_quiz",
    {
      title: "Delete Quiz",
      description:
        "指定レッスンのテストを削除します（物理削除、元に戻せません。関連する受験記録quiz_attemptsは孤立して残ります）。expectedUpdatedAtとconfirmTitle（削除対象の実際のタイトルと完全一致）の両方が必要です。削除後に同じレッスンへテストを作り直しても、過去にそのレッスンで合格していた受講者は新テストを受験できません。",
      inputSchema: deleteQuizSchema,
    },
    async ({ tenant, lessonId, expectedUpdatedAt, confirmTitle }, ctx): Promise<CallToolResult> => {
      try {
        await callToolWithAuth(deps, ctx, "delete_quiz", tenant, lessonId, async (idToken) => {
          const quiz = await assertQuizMatchesExpected(deps.lmsApiClient, tenant, lessonId, expectedUpdatedAt, idToken);
          if (quiz.title !== confirmTitle) {
            throw new QuizDeleteConfirmationError(quiz.title);
          }
          await deps.lmsApiClient.deleteQuiz(tenant, lessonId, idToken);
        });
        return textResult({ deleted: true });
      } catch (error) {
        return mapErrorToResult("delete_quiz", error);
      }
    }
  );

  return server;
}
