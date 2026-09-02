import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createFlushJobHandler } from "../flush-job.js";
import { InMemoryDedupStore } from "./test-helpers.js";

vi.mock("../chat-client.js", () => ({
  postToChat: vi.fn(),
}));
import { postToChat } from "../chat-client.js";

const postToChatMock = vi.mocked(postToChat);

function makeApp(dedupStore: InMemoryDedupStore, now: () => Date = () => new Date("2026-09-02T00:15:00.000Z")) {
  const app = express();
  app.use(express.json());
  app.post(
    "/internal/flush",
    createFlushJobHandler({ dedupStore, webhookSecretName: "secret", now })
  );
  return app;
}

describe("flush-job handler", () => {
  beforeEach(() => {
    postToChatMock.mockReset();
  });

  it("ウィンドウ終了後も後続イベントが無いfingerprintをflushして投稿する", async () => {
    const dedupStore = new InMemoryDedupStore(10 * 60 * 1000);
    // ウィンドウ内で2件抑制された状態を作る
    await dedupStore.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await dedupStore.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    await dedupStore.decide("fp-1", "insert-3", "2026-09-02T00:02:00.000Z");

    postToChatMock.mockResolvedValue({ ok: true, status: 200 });
    const app = makeApp(dedupStore);

    // ウィンドウ(10分)終了後、後続イベントが来ないままflushジョブが起動
    const res = await request(app).post("/internal/flush").send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: 1, flushed: 1 });
    expect(postToChatMock).toHaveBeenCalledTimes(1);
    expect(postToChatMock.mock.calls[0][0]).toContain("2 件抑制");
    expect(dedupStore.size()).toBe(0);
  });

  it("flush対象が無ければ何もしない", async () => {
    const dedupStore = new InMemoryDedupStore();
    const app = makeApp(dedupStore);

    const res = await request(app).post("/internal/flush").send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: 0, flushed: 0 });
    expect(postToChatMock).not.toHaveBeenCalled();
  });

  it("Chat投稿が失敗したfingerprintはmarkFlushedされず次回に持ち越す", async () => {
    const dedupStore = new InMemoryDedupStore(10 * 60 * 1000);
    await dedupStore.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await dedupStore.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    postToChatMock.mockResolvedValue({ ok: false, status: 500 });
    const app = makeApp(dedupStore);

    const res = await request(app).post("/internal/flush").send();

    expect(res.body).toEqual({ pending: 1, flushed: 0 });
    expect(dedupStore.size()).toBe(1);
  });
});
