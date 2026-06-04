/**
 * dispatch-dry-run の lane 単位 single-flight 制御 (Phase 4 α-7、AC-α7-12)。
 *
 * 目的:
 *   - 同じ lane (progress / completion) への dry-run リクエストが進行中の場合、
 *     新規 Firestore read を発生させず、進行中の Promise を共有して同じ結果を返す
 *   - super-admin 連打・複数タブ・ブラウザ再試行のとき、Firestore read 量を
 *     1 リクエスト分に抑える (Codex High 指摘の Firestore read 課金抑制)
 *
 * 設計:
 *   - lane 単位の `Map<lane, Promise<unknown>>` で in-flight Promise を保持
 *   - 完了 (fulfilled or rejected) で Map から自動削除
 *   - module スコープで singleton (process 内で 1 つ、Cloud Run instance scope)
 *
 * 注意:
 *   - Cloud Run の instance scope のため、複数 instance では single-flight が
 *     instance ごとに独立 (許容、limiter で全体は抑制済)
 *   - error 時も結果共有: 進行中 Promise が reject されると、共有していたリクエストも
 *     同じ error を受ける (fail-fast、retry は呼び出し側)
 */

export type DispatchLaneKey = "progress" | "completion";

export interface DispatchDryRunSingleFlight {
  run<T>(lane: DispatchLaneKey, fn: () => Promise<T>): Promise<T>;
}

class DispatchDryRunSingleFlightImpl implements DispatchDryRunSingleFlight {
  private inflight = new Map<DispatchLaneKey, Promise<unknown>>();

  async run<T>(lane: DispatchLaneKey, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(lane);
    if (existing) {
      // 進行中 → 結果共有 (fulfilled / rejected の両方を await で透過)
      return existing as Promise<T>;
    }
    const p = fn().finally(() => {
      // 完了 (resolve / reject 共通) で Map から削除
      // 同じ lane の次回リクエストは新規実行になる
      if (this.inflight.get(lane) === p) {
        this.inflight.delete(lane);
      }
    });
    this.inflight.set(lane, p);
    return p;
  }
}

/**
 * dispatch-dry-run のグローバル singleton single-flight 制御。
 * 各 Cloud Run instance 内で 1 つ。
 */
export const sharedDispatchDryRunSingleFlight: DispatchDryRunSingleFlight =
  new DispatchDryRunSingleFlightImpl();

/**
 * test 用 factory。test ごとに独立 state を持たせるために new instance を返す。
 * production code から呼ばないこと。
 */
export function createDispatchDryRunSingleFlightForTest(): DispatchDryRunSingleFlight {
  return new DispatchDryRunSingleFlightImpl();
}
