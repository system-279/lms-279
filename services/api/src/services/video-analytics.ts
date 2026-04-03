/**
 * 視聴分析の集計ロジック
 * ADR-014: クライアントは生イベント送信、サーバーが集計
 * ADR-022: サーバーサイドヒューリスティクスで不審パターン検出
 */

import type { VideoEvent, VideoAnalytics, WatchedRange, SuspiciousFlag } from "../types/entities.js";
import { logger } from "../utils/logger.js";

/**
 * 視聴区間をマージ（重複排除）
 * 例: [{0,10}, {5,15}, {20,30}] → [{0,15}, {20,30}]
 */
export function mergeWatchedRanges(ranges: WatchedRange[]): WatchedRange[] {
  if (ranges.length === 0) return [];

  // startでソート
  const sorted = [...ranges].sort((a, b) => a.start - b.start);

  const merged: WatchedRange[] = [{ start: sorted[0].start, end: sorted[0].end }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.start <= last.end) {
      // 重複または隣接する区間をマージ
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }

  return merged;
}

/**
 * heartbeatイベントから新しい視聴区間を抽出
 * 連続するheartbeat（位置が5秒以内で増加）を1つの区間にまとめる
 */
export function extractWatchedRangesFromEvents(
  events: VideoEvent[],
  existingRanges: WatchedRange[]
): WatchedRange[] {
  // heartbeatイベントを clientTimestamp でソート
  const heartbeats = events
    .filter((e) => e.eventType === "heartbeat")
    .sort((a, b) => a.clientTimestamp - b.clientTimestamp);

  if (heartbeats.length === 0) {
    return mergeWatchedRanges(existingRanges);
  }

  const newRanges: WatchedRange[] = [];

  // 最初のheartbeatで区間を開始
  let rangeStart = heartbeats[0].position;
  let rangeEnd = heartbeats[0].position;

  for (let i = 1; i < heartbeats.length; i++) {
    const prev = heartbeats[i - 1];
    const curr = heartbeats[i];
    const positionDiff = curr.position - prev.position;

    // 前のpositionから5秒以内で増加していれば連続とみなす
    if (positionDiff > 0 && positionDiff <= 5) {
      rangeEnd = curr.position;
    } else {
      // 不連続 → 現在の区間を確定して新しい区間を開始
      // rangeEnd === rangeStartの場合（heartbeat1個の区間）も、直前5秒の視聴としてレンジ生成
      if (rangeEnd >= rangeStart) {
        const start = rangeEnd === rangeStart ? Math.max(0, rangeStart - 5) : rangeStart;
        newRanges.push({ start, end: rangeEnd });
      }
      rangeStart = curr.position;
      rangeEnd = curr.position;
    }
  }

  // 最後の区間を追加（heartbeat1個の区間も含む）
  if (rangeEnd >= rangeStart) {
    const start = rangeEnd === rangeStart ? Math.max(0, rangeStart - 5) : rangeStart;
    newRanges.push({ start, end: rangeEnd });
  }

  // endedイベントのpositionで最終レンジを拡張（末尾数秒のギャップを閉じる）
  const endedEvent = events.find((e) => e.eventType === "ended");
  if (endedEvent && newRanges.length > 0) {
    const lastRange = newRanges[newRanges.length - 1];
    const gap = endedEvent.position - lastRange.end;
    if (gap > 0 && gap <= 10) {
      lastRange.end = endedEvent.position;
    }
  }

  // 既存rangesとマージ
  return mergeWatchedRanges([...existingRanges, ...newRanges]);
}

/**
 * カバー率を算出
 * coverageRatio = 視聴区間合計時間 / 動画長
 */
export function calculateCoverageRatio(ranges: WatchedRange[], durationSec: number): number {
  if (durationSec <= 0) return 0;

  const totalWatched = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  return Math.min(totalWatched / durationSec, 1.0);
}

/**
 * 不審パターンを検出
 * ADR-022: サーバーサイドヒューリスティクス
 */
export function detectSuspiciousFlags(
  analytics: VideoAnalytics,
  events: VideoEvent[]
): SuspiciousFlag[] {
  const flags: SuspiciousFlag[] = [];

  // excessive_seeks: seekCount > 10
  if (analytics.seekCount > 10) {
    flags.push("excessive_seeks");
  }

  // no_pauses_long_session: 30分以上視聴で一時停止0回
  if (analytics.totalWatchTimeSec > 1800 && analytics.pauseCount === 0) {
    flags.push("no_pauses_long_session");
  }

  // background_playback: visibility_hidden〜visibility_visible間にheartbeatがある
  {
    const sorted = [...events].sort((a, b) => a.clientTimestamp - b.clientTimestamp);
    let inBackground = false;
    let hasBackgroundHeartbeat = false;

    for (const event of sorted) {
      if (event.eventType === "visibility_hidden") {
        inBackground = true;
      } else if (event.eventType === "visibility_visible") {
        inBackground = false;
      } else if (event.eventType === "heartbeat" && inBackground) {
        hasBackgroundHeartbeat = true;
        break;
      }
    }

    if (hasBackgroundHeartbeat) {
      flags.push("background_playback");
    }
  }

  // speed_violation: speedViolationCount > 0
  if (analytics.speedViolationCount > 0) {
    flags.push("speed_violation");
  }

  // position_jump: heartbeat間の位置差が期待値（≈5秒）から大きく乖離
  {
    const heartbeats = events
      .filter((e) => e.eventType === "heartbeat")
      .sort((a, b) => a.clientTimestamp - b.clientTimestamp);

    let hasPositionJump = false;

    for (let i = 1; i < heartbeats.length; i++) {
      const prev = heartbeats[i - 1];
      const curr = heartbeats[i];
      const timeDiffSec = (curr.clientTimestamp - prev.clientTimestamp) / 1000;
      const positionDiff = curr.position - prev.position;

      // 時間差に対して位置の変化が期待値（±10秒の許容）から大きく外れていれば不審
      // timeDiffSecが短い（≤10秒）のに位置差が大きい（>15秒）場合
      if (timeDiffSec <= 10 && Math.abs(positionDiff) > 15) {
        hasPositionJump = true;
        break;
      }
    }

    if (hasPositionJump) {
      flags.push("position_jump");
    }
  }

  return flags;
}

/**
 * イベントバッチからanalytics更新データを算出
 * ADR-014: クライアントは生イベント送信、サーバーが集計
 */
export function processVideoEvents(
  events: VideoEvent[],
  currentAnalytics: VideoAnalytics | null,
  videoDurationSec: number
): Partial<VideoAnalytics> {
  // 1. 現在のanalyticsを取得（なければデフォルト）
  const base: VideoAnalytics = currentAnalytics ?? {
    id: "",
    videoId: "",
    userId: "",
    watchedRanges: [],
    totalWatchTimeSec: 0,
    coverageRatio: 0,
    isComplete: false,
    seekCount: 0,
    pauseCount: 0,
    totalPauseDurationSec: 0,
    speedViolationCount: 0,
    suspiciousFlags: [],
    updatedAt: new Date().toISOString(),
  };

  // 2. イベントからカウント更新
  let seekCountDelta = 0;
  let pauseCountDelta = 0;
  let speedViolationCountDelta = 0;

  for (const event of events) {
    if (event.eventType === "seeked") {
      seekCountDelta++;
    } else if (event.eventType === "pause") {
      pauseCountDelta++;
    } else if (event.eventType === "ratechange" && event.playbackRate > 1) {
      speedViolationCountDelta++;
    }
  }

  const updatedSeekCount = base.seekCount + seekCountDelta;
  const updatedPauseCount = base.pauseCount + pauseCountDelta;
  const updatedSpeedViolationCount = base.speedViolationCount + speedViolationCountDelta;

  // 3. heartbeatから視聴区間抽出・マージ
  const updatedWatchedRanges = extractWatchedRangesFromEvents(events, base.watchedRanges);

  // 4. coverageRatio算出
  const updatedCoverageRatio = calculateCoverageRatio(updatedWatchedRanges, videoDurationSec);

  // 5. totalWatchTimeSec算出（マージ済み区間の合計）
  const updatedTotalWatchTimeSec = updatedWatchedRanges.reduce(
    (sum, r) => sum + (r.end - r.start),
    0
  );

  // 6. 不審パターン検出（最新カウントで判定するため仮analyticsを組み立てる）
  const analyticsForDetection: VideoAnalytics = {
    ...base,
    seekCount: updatedSeekCount,
    pauseCount: updatedPauseCount,
    speedViolationCount: updatedSpeedViolationCount,
    totalWatchTimeSec: updatedTotalWatchTimeSec,
    watchedRanges: updatedWatchedRanges,
    coverageRatio: updatedCoverageRatio,
  };

  const updatedSuspiciousFlags = detectSuspiciousFlags(analyticsForDetection, events);

  if (updatedSuspiciousFlags.length > 0) {
    logger.warn("Suspicious activity detected", {
      userId: base.userId, videoId: base.videoId,
      flags: updatedSuspiciousFlags,
      seekCount: updatedSeekCount,
      pauseCount: updatedPauseCount,
      speedViolationCount: updatedSpeedViolationCount,
    });
  }

  // isComplete判定はcaller側で requiredWatchRatio と比較して行う
  return {
    watchedRanges: updatedWatchedRanges,
    totalWatchTimeSec: updatedTotalWatchTimeSec,
    coverageRatio: updatedCoverageRatio,
    seekCount: updatedSeekCount,
    pauseCount: updatedPauseCount,
    speedViolationCount: updatedSpeedViolationCount,
    suspiciousFlags: updatedSuspiciousFlags,
  };
}
