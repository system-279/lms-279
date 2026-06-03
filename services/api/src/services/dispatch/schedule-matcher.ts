/**
 * 配信スケジュール (scheduleDaysOfWeek + scheduleHourJst) と
 * 現在 JST 時刻を照合する純粋関数。
 *
 * 設計仕様書 §3.2、FR-2、AC-6 / AC-7 に対応。
 * Phase 3 (ADR-039): 進捗レポート定期自動配信 sub-schedule 用に共通 helper を抽出し、
 * `shouldRunProgressReportNow` を追加 (AC-PR-01 / AC-PR-05)。
 *
 * Cloud Scheduler は毎時 JST 00 分起動 (`time-zone: Asia/Tokyo`) で固定だが、
 * 配信スケジュールの柔軟性 (曜日 + 時刻) は DB 設定値で実現する。
 * 本関数は cron 起動時に「今が配信時刻か」を判定するためだけに使う純粋関数。
 *
 * JST は固定 UTC+9 (DST なし、ADR-029)。
 */

import {
  JST_OFFSET_MS,
  type DispatchSettings,
  type ProgressReportSettings,
} from "@lms-279/shared-types";

/**
 * 汎用スケジュール判定 (enabled + scheduleDaysOfWeek + scheduleHourJst)。
 * 完了通知レーン / 進捗レポートレーンで構造を共有 (PR 3c DRY、Codex Plan 反映)。
 */
function matchesSchedule(
  enabled: boolean,
  scheduleDaysOfWeek: readonly number[],
  scheduleHourJst: number,
  now: Date,
): boolean {
  if (!enabled) return false;
  if (scheduleDaysOfWeek.length === 0) return false;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  if (!scheduleDaysOfWeek.includes(jst.getUTCDay())) return false;
  if (jst.getUTCHours() !== scheduleHourJst) return false;
  return true;
}

/**
 * 完了通知レーンの schedule 判定。
 *
 * @param settings 配信設定
 * @param now 現在時刻 (UTC、Date 型)。テストで固定できるよう注入可能
 * @returns true なら配信処理を実行、false なら何もしない (200 で即終了)
 */
export function shouldRunNow(settings: DispatchSettings, now: Date): boolean {
  return matchesSchedule(
    settings.enabled,
    settings.scheduleDaysOfWeek,
    settings.scheduleHourJst,
    now,
  );
}

/**
 * 進捗レポートレーンの schedule 判定 (Phase 3 ADR-039、AC-PR-01 / AC-PR-05)。
 *
 * `progressReport` が undefined (未設定) なら disable と同等扱いで false。
 * `progressReport.enabled=false` (kill switch、AC-PR-22) でも false。
 *
 * @param progressReport 進捗レポート sub-schedule 設定 (undefined 可)
 * @param now 現在時刻 (UTC、Date 型)
 * @returns true なら配信処理を実行、false なら何もしない
 */
export function shouldRunProgressReportNow(
  progressReport: ProgressReportSettings | undefined,
  now: Date,
): boolean {
  if (!progressReport) return false;
  return matchesSchedule(
    progressReport.enabled,
    progressReport.scheduleDaysOfWeek,
    progressReport.scheduleHourJst,
    now,
  );
}
