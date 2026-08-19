/**
 * テスト任意化 Stage 5(ケースD厳格化): テストでレッスンセッションを HTTP 経由で開始するヘルパー。
 * POST /lesson-sessions は既存 active セッションがあると 201 ではなく 200 を返すため、
 * 呼び出し元は取得したステータスを固定アサートしないこと。
 */
import type supertest from "supertest";

export async function createActiveSessionViaHttp(
  request: ReturnType<typeof supertest>,
  params: { lessonId: string; videoId: string; sessionToken?: string }
) {
  const res = await request.post("/lesson-sessions").send({
    lessonId: params.lessonId,
    videoId: params.videoId,
    sessionToken: params.sessionToken ?? `token-${params.lessonId}`,
  });
  return res;
}
