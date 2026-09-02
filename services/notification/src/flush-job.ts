/**
 * Cloud Scheduler（10分毎）が呼ぶ、集約ウィンドウの flush ハンドラ。
 *
 * dedup.ts の集約ウィンドウが終了しても後続イベントが来ない場合、抑制件数が
 * 投稿されないまま残ってしまう（クロスレビュー High #8）。本ジョブが定期的に
 * 未フラッシュの抑制件数を回収し、まとめて投稿する。
 */

import type { Request, Response } from "express";
import type { DedupStore } from "./dedup.js";
import { buildFlushSummaryText } from "./chat-payload-allowlist.js";
import { postToChat } from "./chat-client.js";
import { logger } from "./logger.js";

export interface FlushJobDeps {
  dedupStore: DedupStore;
  webhookSecretName: string;
  now?: () => Date;
}

export function createFlushJobHandler(deps: FlushJobDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const now = (deps.now ?? (() => new Date()))();
    const pending = await deps.dedupStore.listPendingFlush(now.toISOString());

    let flushed = 0;
    for (const item of pending) {
      const text = buildFlushSummaryText(`fingerprint: ${item.fingerprint.slice(0, 12)}…`, item.suppressedCount);
      const result = await postToChat(text, deps.webhookSecretName);
      if (result.ok) {
        await deps.dedupStore.markFlushed(item.fingerprint);
        flushed += 1;
      } else {
        logger.error("flush-job: Chat 投稿に失敗したため今回は flush をスキップします", {
          fingerprint: item.fingerprint,
        });
      }
    }

    res.status(200).json({ pending: pending.length, flushed });
  };
}
