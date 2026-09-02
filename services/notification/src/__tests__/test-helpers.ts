/**
 * テスト専用のフェイク実装。本番コードからは import しない。
 */

import type { DedupStore, DedupDecision, PendingFlush } from "../dedup.js";
import { decideDedup, type DedupDocState } from "../dedup.js";
import type { OidcTokenVerifier, VerifiedOidcCaller } from "../oidc-verify.js";

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/** dedup.ts の decideDedup をそのまま使うインメモリ DedupStore（Firestore不要） */
export class InMemoryDedupStore implements DedupStore {
  private docs = new Map<string, DedupDocState & { needsFlush: boolean }>();

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  async decide(fingerprint: string, insertId: string, nowIso: string): Promise<DedupDecision> {
    const existing = this.docs.get(fingerprint);
    const { decision, nextState } = decideDedup(existing, insertId, nowIso, this.windowMs);
    const needsFlush = !decision.shouldPost && nextState.suppressedCount > 0;
    this.docs.set(fingerprint, { ...nextState, needsFlush });
    return decision;
  }

  async listPendingFlush(nowIso: string): Promise<PendingFlush[]> {
    const now = new Date(nowIso).getTime();
    const result: PendingFlush[] = [];
    for (const [fingerprint, doc] of this.docs.entries()) {
      if (doc.needsFlush && new Date(doc.windowEndsAt).getTime() < now) {
        result.push({ fingerprint, suppressedCount: doc.suppressedCount });
      }
    }
    return result;
  }

  async markFlushed(fingerprint: string): Promise<void> {
    this.docs.delete(fingerprint);
  }

  /** テストの中身確認用 */
  size(): number {
    return this.docs.size;
  }
}

/** 常に成功する OIDC verifier（テスト用）。email を差し替え可能にする */
export function makeFakeOidcVerifier(caller: VerifiedOidcCaller): OidcTokenVerifier {
  return {
    verify: async () => caller,
  };
}
