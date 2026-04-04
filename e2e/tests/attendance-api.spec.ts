/**
 * 出席管理システム E2E テスト
 * Issue #157: QA手動検証の自動化
 *
 * e2e-test テナント（InMemoryDataSource, 書き込み可能）を使用。
 * PAUSE_TIMEOUT_MS=5000（5秒）でpause timeoutを高速テスト。
 */

import { test, expect } from "@playwright/test";

const API_BASE = "http://localhost:8080/api/v2/e2e-test";
const AUTH_HEADERS = {
  "X-User-Id": "demo-student-1",
  "X-User-Role": "student",
  "X-User-Email": "student1@demo.example.com",
};
const LESSON_ID = "demo-lesson-1";
const VIDEO_ID = "demo-video-1";

// セッション作成
async function createSession(
  request: ReturnType<typeof test.info>["_test"] extends never ? never : Parameters<Parameters<typeof test>[1]>[0]["request"],
  sessionToken: string
) {
  const res = await request.post(`${API_BASE}/lesson-sessions`, {
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    data: { lessonId: LESSON_ID, videoId: VIDEO_ID, sessionToken },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return body.session;
}

// イベント送信
async function sendEvents(
  request: any,
  sessionToken: string,
  events: Array<{ eventType: string; position: number; playbackRate?: number; clientTimestamp: number }>
) {
  return request.post(`${API_BASE}/videos/${VIDEO_ID}/events`, {
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    data: {
      sessionToken,
      events: events.map((e) => ({
        ...e,
        playbackRate: e.playbackRate ?? 1,
      })),
    },
  });
}

// 95%カバレッジ分のheartbeatバッチ生成（durationSec=596, requiredWatchRatio=0.95）
// バッチ境界で最後のpositionを次バッチの先頭に重複させ、watchedRangesのgapを防ぐ
function generateCoverageBatches(baseTime: number) {
  const batches: Array<Array<{ eventType: string; position: number; clientTimestamp: number }>> = [];
  // バッチ1: 0〜245 (50件)
  const batch1 = Array.from({ length: 50 }, (_, i) => ({
    eventType: "heartbeat" as const,
    position: i * 5,
    clientTimestamp: baseTime + i * 5000,
  }));
  // バッチ2: 245〜490 (50件, 245を重複して含める)
  const batch2 = Array.from({ length: 50 }, (_, i) => ({
    eventType: "heartbeat" as const,
    position: 245 + i * 5,
    clientTimestamp: baseTime + (50 + i) * 5000,
  }));
  // バッチ3: 490〜575 (18件, 490を重複して含める)
  const batch3 = Array.from({ length: 18 }, (_, i) => ({
    eventType: "heartbeat" as const,
    position: 490 + i * 5,
    clientTimestamp: baseTime + (100 + i) * 5000,
  }));
  batches.push(batch1, batch2, batch3);
  return batches;
}

test.describe.serial("出席管理 E2E テスト", () => {
  // テストスイート開始時にDataSourceをリセット（前回実行の残留データを排除）
  test.beforeAll(async ({ request }) => {
    await request.post(`${API_BASE}/__reset`);
  });

  // 各テスト前にアクティブセッションをクリーンアップ
  test.beforeEach(async ({ request }) => {
    const res = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    if (res.status() === 200) {
      const { session } = await res.json();
      if (session) {
        await request.post(`${API_BASE}/lesson-sessions/${session.id}/abandon`);
      }
    }
  });

  test("項目6: sessionToken不一致でイベント送信が400で拒否される", async ({ request }) => {
    const token = crypto.randomUUID();
    await createSession(request, token);

    // 別のtokenでイベント送信 → 400
    const wrongToken = crypto.randomUUID();
    const res = await sendEvents(request, wrongToken, [
      { eventType: "heartbeat", position: 10, clientTimestamp: Date.now() },
    ]);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("session_token_mismatch");

    // 正しいtokenでイベント送信 → 200
    const res2 = await sendEvents(request, token, [
      { eventType: "heartbeat", position: 10, clientTimestamp: Date.now() },
    ]);
    expect(res2.status()).toBe(200);
  });

  test("項目3: pause/play状態遷移が正常に動作する", async ({ request }) => {
    const token = crypto.randomUUID();
    const session = await createSession(request, token);
    const baseTime = Date.now();

    // play → heartbeat → pause → play → heartbeat: 全て200
    const res1 = await sendEvents(request, token, [
      { eventType: "play", position: 0, clientTimestamp: baseTime },
    ]);
    expect(res1.status()).toBe(200);

    const res2 = await sendEvents(request, token, [
      { eventType: "heartbeat", position: 5, clientTimestamp: baseTime + 5000 },
      { eventType: "pause", position: 10, clientTimestamp: baseTime + 10000 },
    ]);
    expect(res2.status()).toBe(200);

    const res3 = await sendEvents(request, token, [
      { eventType: "play", position: 10, clientTimestamp: baseTime + 13000 },
    ]);
    expect(res3.status()).toBe(200);

    const res4 = await sendEvents(request, token, [
      { eventType: "heartbeat", position: 15, clientTimestamp: baseTime + 15000 },
    ]);
    expect(res4.status()).toBe(200);

    // セッションがactiveのまま
    const activeRes = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    expect(activeRes.status()).toBe(200);
    const { session: activeSession } = await activeRes.json();
    expect(activeSession.status).toBe("active");
    expect(activeSession.id).toBe(session.id);
  });

  test("項目5: タブ切替後もセッションがactiveを維持する", async ({ request }) => {
    const token = crypto.randomUUID();
    await createSession(request, token);
    const baseTime = Date.now();

    // play → visibility_hidden → visibility_visible → heartbeat
    await sendEvents(request, token, [
      { eventType: "play", position: 0, clientTimestamp: baseTime },
    ]);

    const res1 = await sendEvents(request, token, [
      { eventType: "visibility_hidden", position: 30, clientTimestamp: baseTime + 30000 },
    ]);
    expect(res1.status()).toBe(200);

    const res2 = await sendEvents(request, token, [
      { eventType: "visibility_visible", position: 30, clientTimestamp: baseTime + 35000 },
    ]);
    expect(res2.status()).toBe(200);

    const res3 = await sendEvents(request, token, [
      { eventType: "heartbeat", position: 35, clientTimestamp: baseTime + 40000 },
    ]);
    expect(res3.status()).toBe(200);

    // セッションがactiveのまま
    const activeRes = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    expect(activeRes.status()).toBe(200);
    const { session } = await activeRes.json();
    expect(session.status).toBe("active");
  });

  test("項目2: 動画95%視聴でsessionVideoCompletedがtrueになる", async ({ request }) => {
    const token = crypto.randomUUID();
    await createSession(request, token);
    const baseTime = Date.now();

    // play送信
    await sendEvents(request, token, [
      { eventType: "play", position: 0, clientTimestamp: baseTime },
    ]);

    // 3バッチでheartbeat送信（50+50+15件）
    const batches = generateCoverageBatches(baseTime + 1000);
    let lastRes;
    for (const batch of batches) {
      lastRes = await sendEvents(request, token, batch);
      expect(lastRes.status()).toBe(200);
    }

    // 最終バッチのレスポンスでisComplete=true
    const body = await lastRes!.json();
    expect(body.analytics.isComplete).toBe(true);

    // セッションのsessionVideoCompleted=true
    const activeRes = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    expect(activeRes.status()).toBe(200);
    const { session } = await activeRes.json();
    expect(session.sessionVideoCompleted).toBe(true);
  });

  test("項目1: abandonでセッションが終了する", async ({ request }) => {
    const token = crypto.randomUUID();
    const session = await createSession(request, token);

    // play送信（セッションをactive状態にする）
    await sendEvents(request, token, [
      { eventType: "play", position: 0, clientTimestamp: Date.now() },
    ]);

    // abandon
    const abandonRes = await request.post(
      `${API_BASE}/lesson-sessions/${session.id}/abandon`
    );
    expect(abandonRes.status()).toBe(204);

    // activeセッションがなくなる（200 + session: null）
    const activeRes = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    expect(activeRes.status()).toBe(200);
    const activeBody = await activeRes.json();
    expect(activeBody.session).toBeNull();
  });

  test("項目4: pause timeout後のイベント送信で強制退室される", async ({ request }) => {
    // PAUSE_TIMEOUT_MS=5000（5秒）で設定済み
    const token = crypto.randomUUID();
    await createSession(request, token);

    // play → pause（clientTimestampは現在時刻ベース。pauseStartedAtに使われるため）
    const playTime = Date.now();
    await sendEvents(request, token, [
      { eventType: "play", position: 0, clientTimestamp: playTime },
    ]);
    const pauseTime = Date.now();
    await sendEvents(request, token, [
      { eventType: "pause", position: 30, clientTimestamp: pauseTime },
    ]);

    // 8秒待機（PAUSE_TIMEOUT_MS=5000を十分超過。CI環境のタイミングずれを考慮）
    await new Promise((resolve) => setTimeout(resolve, 8000));

    // heartbeat送信 → 409
    const res = await sendEvents(request, token, [
      { eventType: "heartbeat", position: 30, clientTimestamp: Date.now() },
    ]);
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("session_force_exited");
  });

  test("項目7: 統合シナリオ（完了→pause→play→abandon）", async ({ request }) => {
    const token = crypto.randomUUID();
    const session = await createSession(request, token);
    const baseTime = Date.now();

    // 1. play
    await sendEvents(request, token, [
      { eventType: "play", position: 0, clientTimestamp: baseTime },
    ]);

    // 2. 95%視聴
    const batches = generateCoverageBatches(baseTime + 1000);
    for (const batch of batches) {
      const res = await sendEvents(request, token, batch);
      expect(res.status()).toBe(200);
    }

    // sessionVideoCompleted=true確認
    let activeRes = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    expect(activeRes.status()).toBe(200);
    let activeSession = (await activeRes.json()).session;
    expect(activeSession.sessionVideoCompleted).toBe(true);

    // 3. pause
    const pauseTime = baseTime + 600000;
    await sendEvents(request, token, [
      { eventType: "pause", position: 570, clientTimestamp: pauseTime },
    ]);

    // 4. play（再開）
    await sendEvents(request, token, [
      { eventType: "play", position: 570, clientTimestamp: pauseTime + 3000 },
    ]);

    // セッションはまだactive
    activeRes = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    expect(activeRes.status()).toBe(200);

    // 5. abandon
    const abandonRes = await request.post(
      `${API_BASE}/lesson-sessions/${session.id}/abandon`
    );
    expect(abandonRes.status()).toBe(204);

    // 6. activeセッションなし
    activeRes = await request.get(
      `${API_BASE}/lesson-sessions/active?lessonId=${LESSON_ID}`,
      { headers: AUTH_HEADERS }
    );
    expect(activeRes.status()).toBe(404);

    // 7. 新しいセッション作成可能
    const newToken = crypto.randomUUID();
    const newSession = await createSession(request, newToken);
    expect(newSession.id).not.toBe(session.id);
    expect(newSession.status).toBe("active");
  });
});
