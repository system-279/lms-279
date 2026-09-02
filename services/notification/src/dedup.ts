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
  /** markFlushed に渡し、読み取り後に新しいウィンドウが始まっていないかの条件付き削除に使う */
  windowEndsAt: string;
}

export interface DedupStore {
  decide(fingerprint: string, insertId: string, nowIso: string): Promise<DedupDecision>;
  /**
   * decide() が shouldPost:true を返した直後に Chat 投稿が transient 失敗した場合に呼ぶ。
   * decide() が書き込んだ状態を打ち消し、Pub/Sub の再配信時に同じイベントとして再判定
   * できるようにする（呼ばないと insertId が seenInsertIds に残り続け、再配信が
   * shouldPost:false になって通知が永久に失われる）。
   *
   * @param restoreSuppressedCount decide() が返した decision.suppressedSincePrevious。
   *   ウィンドウ境界をまたいだ直後の shouldPost:true（decideDedup の rollover 分岐）を
   *   rollback すると、その書き込みは常に suppressedCount:0 にリセットされているため、
   *   これを渡さないと直前ウィンドウの抑制件数が跡形もなく失われる
   *   （pr-review-toolkit silent-failure-hunter 指摘、CRITICAL）。
   */
  rollback(fingerprint: string, insertId: string, restoreSuppressedCount: number): Promise<void>;
  listPendingFlush(nowIso: string): Promise<PendingFlush[]>;
  /** listPendingFlush 時点の windowEndsAt と一致する場合のみ削除する（新規ウィンドウとの競合防止） */
  markFlushed(fingerprint: string, windowEndsAt: string): Promise<void>;
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

  /**
   * decide() が shouldPost:true を書き込んだ直後、その insertId を seenInsertIds から
   * 取り除く。全消し（旧実装）だと、rollback対象のイベント処理中に同一fingerprintの
   * 別イベントが到着してウィンドウ内に取り込まれていた場合、そのイベントの分まで
   * 巻き添えで消してしまい、二重の意味で通知を失う（codex review 指摘）。
   *
   * さらに、rollback対象がウィンドウロールオーバーの書き込み（decideDedup が
   * suppressedCount:0 にリセットした直後）だった場合、restoreSuppressedCount を
   * 使って直前ウィンドウの抑制件数を復元する。復元先は windowEndsAt を過去日時に
   * 設定した「即座に期限切れ」のドキュメントにし、次のイベントで正しく
   * ウィンドウロールオーバーとして再報告されるようにする（flush ジョブからも
   * 即座に回収可能）（pr-review-toolkit silent-failure-hunter 指摘、CRITICAL）。
   */
  async rollback(fingerprint: string, insertId: string, restoreSuppressedCount: number): Promise<void> {
    const docRef = this.db.collection(COLLECTION).doc(fingerprint);
    try {
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) return;
        const data = snap.data() as StoredDoc;
        if (!data.seenInsertIds.includes(insertId)) return;
        const remainingIds = data.seenInsertIds.filter((id) => id !== insertId);

        if (remainingIds.length > 0) {
          // 他のイベントがこのウィンドウに乗っている。それらの状態は保ちつつ、
          // 復元すべき抑制件数があれば合算する（このinsertIdがrolloverの
          // 起点だった場合、直前ウィンドウの分を失わないため）。
          tx.update(docRef, {
            seenInsertIds: remainingIds,
            suppressedCount: data.suppressedCount + restoreSuppressedCount,
          });
          return;
        }

        if (restoreSuppressedCount === 0) {
          // 新規fingerprintとしての投稿がrollback対象だった。他に何も残って
          // いないのでdocごと削除し、まっさらな新規fingerprintの状態に戻す。
          tx.delete(docRef);
          return;
        }

        const epoch = new Date(0).toISOString();
        tx.set(docRef, {
          suppressedCount: restoreSuppressedCount,
          windowEndsAt: epoch,
          seenInsertIds: [],
          needsFlush: true,
          ttlExpireAt: data.ttlExpireAt,
        });
      });
    } catch (err) {
      logger.error("dedup rollback failed", {
        fingerprint,
        insertId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async listPendingFlush(nowIso: string): Promise<PendingFlush[]> {
    const snap = await this.db
      .collection(COLLECTION)
      .where("needsFlush", "==", true)
      .where("windowEndsAt", "<", nowIso)
      .get();
    return snap.docs.map((d) => {
      const data = d.data() as StoredDoc;
      return { fingerprint: d.id, suppressedCount: data.suppressedCount, windowEndsAt: data.windowEndsAt };
    });
  }

  /** listPendingFlush 時点から windowEndsAt が変わっていない場合のみ削除する */
  async markFlushed(fingerprint: string, windowEndsAt: string): Promise<void> {
    const docRef = this.db.collection(COLLECTION).doc(fingerprint);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return;
      const data = snap.data() as StoredDoc;
      if (data.windowEndsAt === windowEndsAt) {
        tx.delete(docRef);
      }
      // windowEndsAt が変わっている = flush対象読み取り後に新しいイベントが到着し
      // 新ウィンドウが始まっている。その新しい状態を誤って消さないよう何もしない。
    });
  }
}
