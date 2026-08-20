/**
 * 出席記録の異常検知バッジ・フィルタ用ラベルと判定関数（F2、ADR-027）。
 *
 * 異常は API 側 (session-anomaly.ts) でオンザフライ計算され `anomalies?: SessionAnomalyType[]`
 * として返る。本 helper は表示ラベルと「異常のみ」フィルタの判定のみを担う。
 */

import type { SessionAnomalyType } from "@lms-279/shared-types";

export const ANOMALY_LABELS: Record<SessionAnomalyType, string> = {
  overlap_previous: "重複",
  negative_duration: "負滞在",
  stale_active: "放置",
};

export const ANOMALY_TOOLTIPS: Record<SessionAnomalyType, string> = {
  overlap_previous: "同一受講者の別セッションと入退室時刻が重複しています。",
  negative_duration: "退室時刻が入室時刻より前になっています（データ不整合）。",
  stale_active: "在室中のまま長時間（セッション制限時間超過）放置されています。",
};

/** 表示順を固定するための定義順配列。Object.keys() の順序に依存しない。 */
export const ANOMALY_TYPES: SessionAnomalyType[] = [
  "overlap_previous",
  "negative_duration",
  "stale_active",
];

export function anomalyLabel(type: SessionAnomalyType): string {
  switch (type) {
    case "overlap_previous":
    case "negative_duration":
    case "stale_active":
      return ANOMALY_LABELS[type];
    default: {
      // SessionAnomalyType に新しい値が追加された際、TypeScript が網羅漏れを検出する
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export function hasAnomaly(anomalies: SessionAnomalyType[] | undefined): boolean {
  return !!anomalies && anomalies.length > 0;
}

export type AnomalyFilterKind = "all" | "anomaly_only";

export const ANOMALY_FILTER_OPTIONS: { value: AnomalyFilterKind; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "anomaly_only", label: "異常のみ" },
];

/** 純粋関数: AnomalyFilterKind フィルタ値とレコードの anomalies を突き合わせて表示すべきか判定。 */
export function matchesAnomalyFilter(
  recordAnomalies: SessionAnomalyType[] | undefined,
  kind: AnomalyFilterKind,
): boolean {
  switch (kind) {
    case "all":
      return true;
    case "anomaly_only":
      return hasAnomaly(recordAnomalies);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
