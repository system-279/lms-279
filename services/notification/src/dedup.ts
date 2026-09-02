/**
 * 同一エラーの連続発生を集約（dedup）するロジック。
 *
 * 設計方針（運用通知自動化プラン参照）:
 *   - 決定ロジック（decideDedup）は Firestore に依存しない pure 関数として切り出す。
 *     並行性の安全性は Firestore の runTransaction（read-modify-write の atomicity）という
 *     信頼できるプリミティブに委ね、こちらでは「入力状態→出力状態」の分岐が正しいことだけを
 *     ユニットテストで厚く担保する（クロスレビューで「自信が低い」と自白した箇所への対応）。
 *   - トランザクション競合時は有限リトライ後、集約をあきらめて個別投稿にフォールバックする
 *     （集約に失敗しても通知そのものは失われない）。
 *   - ウィンドウが終了しても後続イベントが来ない場合に抑制件数が投稿されないままにならない
 *     よう、flush ジョブ（flush-job.ts）が別途未フラッシュの抑制件数を回収する。
 */

import { Firestore, Timestamp } from "@google-cloud/firestore";
import { logger } from "./logger.js";

const COLLECTION = "ops_notification_dedup";
const MAX_TRACKED_INSERT_IDS = 20;
const MAX_TRANSACTION_ATTEMPTS = 3;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface DedupDocState {
  suppressedCount: number;
  windowEndsAt: string; // ISO
  seenInsertIds: string[];
}

export interface DedupDecision {
  shouldPost: boolean;
  suppressedSincePrevious: number;
}

/**
 * 集約の意思決定を行う pure 関数。
 *
 * - doc が無い（新規 fingerprint）→ 投稿する、新ウィンドウを開始
 * - insertId が既知（Pub/Sub の at-least-once 再配信）→ 状態を変えず、投稿もしない
 * - ウィンドウ内の新規イベント → 抑制件数を増やすのみ、投稿しない
 * - ウィンドウ外の新規イベント → 投稿する、直前ウィンドウの抑制件数を添える、新ウィンドウ開始
 */
export function decideDedup(
  doc: DedupDocState | undefined,
  insertId: string,
  nowIso: string,
  windowMs: number
): { decision: DedupDecision; nextState: DedupDocState } {
  const now = new Date(nowIso).getTime();

  if (!doc) {
    return {
      decision: { shouldPost: true, suppressedSincePrevious: 0 },
      nextState: {
        suppressedCount: 0,
        windowEndsAt: new Date(now + windowMs).toISOString(),
        seenInsertIds: [insertId],
      },
    };
  }

  if (doc.seenInsertIds.includes(insertId)) {
    return {
      decision: { shouldPost: false, suppressedSincePrevious: 0 },
      nextState: doc,
    };
  }

  const windowEndMs = new Date(doc.windowEndsAt).getTime();
  const nextInsertIds = [...doc.seenInsertIds, insertId].slice(-MAX_TRACKED_INSERT_IDS);

  if (now < windowEndMs) {
    return {
      decision: { shouldPost: false, suppressedSincePrevious: 0 },
      nextState: {
        suppressedCount: doc.suppressedCount + 1,
        windowEndsAt: doc.windowEndsAt,
        seenInsertIds: nextInsertIds,
      },
    };
  }

  return {
    decision: { shouldPost: true, suppressedSincePrevious: doc.suppressedCount },
    nextState: {
      suppressedCount: 0,
      windowEndsAt: new Date(now + windowMs).toISOString(),
      seenInsertIds: [insertId],
    },
  };
}

export interface PendingFlush {
  fingerprint: string;
  suppressedCount: number;
}

export interface DedupStore {
  decide(fingerprint: string, insertId: string, nowIso: string): Promise<DedupDecision>;
  listPendingFlush(nowIso: string): Promise<PendingFlush[]>;
  markFlushed(fingerprint: string): Promise<void>;
}

interface StoredDoc extends DedupDocState {
  needsFlush: boolean;
  ttlExpireAt: Timestamp;
}

export class FirestoreDedupStore implements DedupStore {
  constructor(
    private readonly db: Firestore,
    private readonly windowMs: number
  ) {}

  async decide(fingerprint: string, insertId: string, nowIso: string): Promise<DedupDecision> {
    const docRef = this.db.collection(COLLECTION).doc(fingerprint);

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
      try {
        return await this.db.runTransaction(async (tx) => {
          const snap = await tx.get(docRef);
          const existing = snap.exists ? (snap.data() as StoredDoc) : undefined;
          const { decision, nextState } = decideDedup(existing, insertId, nowIso, this.windowMs);

          const ttlExpireAt = Timestamp.fromDate(new Date(new Date(nowIso).getTime() + TTL_MS));
          const needsFlush = !decision.shouldPost && nextState.suppressedCount > 0;
          tx.set(docRef, { ...nextState, needsFlush, ttlExpireAt });

          return decision;
        });
      } catch (err) {
        logger.warn("dedup transaction attempt failed", {
          attempt,
          fingerprint,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        if (attempt === MAX_TRANSACTION_ATTEMPTS) {
          logger.error(
            "dedup transaction exhausted retries, falling back to individual post",
            { fingerprint }
          );
          return { shouldPost: true, suppressedSincePrevious: 0 };
        }
      }
    }
    // 到達しないが型のため
    return { shouldPost: true, suppressedSincePrevious: 0 };
  }

  async listPendingFlush(nowIso: string): Promise<PendingFlush[]> {
    const snap = await this.db
      .collection(COLLECTION)
      .where("needsFlush", "==", true)
      .where("windowEndsAt", "<", nowIso)
      .get();
    return snap.docs.map((d) => {
      const data = d.data() as StoredDoc;
      return { fingerprint: d.id, suppressedCount: data.suppressedCount };
    });
  }

  async markFlushed(fingerprint: string): Promise<void> {
    await this.db.collection(COLLECTION).doc(fingerprint).delete();
  }
}
