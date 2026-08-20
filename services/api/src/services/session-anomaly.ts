/**
 * 出席記録の異常検知（F2、ADR-027）。
 *
 * DataSource 非依存の純粋関数。super-admin.ts（生 Firestore doc）と
 * analytics.ts（LessonSession エンティティ）の両方から呼べるよう、
 * 最小限のフィールドのみを要求する AnomalyCandidate を入力形状とする。
 *
 * synthetic session（isSynthetic=true）は entryAt/exitAt が実測ではなく
 * quiz_attempt から換算された値のため、overlap 検知のスイープ対象から除外する
 * （除外しないと合格提出のたびに誤検知が発生する）。stale_active 判定は
 * synthetic session が常に status="completed" で作成されるため対象外になる。
 */

import type { SessionAnomalyType } from "@lms-279/shared-types";
import { SESSION_DURATION_MS } from "./lesson-session.js";

export type { SessionAnomalyType };

export interface AnomalyCandidate {
  sessionId: string;
  userId: string;
  status: string;
  entryAt: string | null;
  exitAt: string | null;
  isSynthetic: boolean;
}

function parseMs(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function addAnomaly(
  result: Map<string, SessionAnomalyType[]>,
  sessionId: string,
  type: SessionAnomalyType
): void {
  const existing = result.get(sessionId);
  if (existing) {
    existing.push(type);
  } else {
    result.set(sessionId, [type]);
  }
}

export function detectSessionAnomalies(
  sessions: AnomalyCandidate[],
  now: Date
): Map<string, SessionAnomalyType[]> {
  const result = new Map<string, SessionAnomalyType[]>();
  const nowMs = now.getTime();

  const byUser = new Map<string, AnomalyCandidate[]>();
  for (const s of sessions) {
    const group = byUser.get(s.userId);
    if (group) {
      group.push(s);
    } else {
      byUser.set(s.userId, [s]);
    }
  }

  for (const group of byUser.values()) {
    const negativeDurationIds = new Set<string>();

    // negative_duration: exitAt < entryAt（データ不整合）
    for (const s of group) {
      const entryMs = parseMs(s.entryAt);
      const exitMs = parseMs(s.exitAt);
      if (entryMs === null || exitMs === null) continue;
      if (exitMs < entryMs) {
        addAnomaly(result, s.sessionId, "negative_duration");
        negativeDurationIds.add(s.sessionId);
      }
    }

    // stale_active: active のまま SESSION_DURATION_MS を超えて放置
    for (const s of group) {
      if (s.status !== "active") continue;
      const entryMs = parseMs(s.entryAt);
      if (entryMs === null) continue;
      if (nowMs - entryMs > SESSION_DURATION_MS) {
        addAnomaly(result, s.sessionId, "stale_active");
      }
    }

    // overlap_previous: 非synthetic・終端・パース可能・非負のみをスイープ対象とする
    const sweepable = group
      .filter((s) => !s.isSynthetic)
      .filter((s) => s.exitAt !== null)
      .filter((s) => !negativeDurationIds.has(s.sessionId))
      .map((s) => ({ s, entryMs: parseMs(s.entryAt), exitMs: parseMs(s.exitAt) }))
      .filter(
        (x): x is { s: AnomalyCandidate; entryMs: number; exitMs: number } =>
          x.entryMs !== null && x.exitMs !== null
      )
      .sort((a, b) => a.entryMs - b.entryMs);

    let maxExitSoFar = -Infinity;
    for (const { s, entryMs, exitMs } of sweepable) {
      if (entryMs < maxExitSoFar) {
        addAnomaly(result, s.sessionId, "overlap_previous");
      }
      if (exitMs > maxExitSoFar) {
        maxExitSoFar = exitMs;
      }
    }
  }

  return result;
}
