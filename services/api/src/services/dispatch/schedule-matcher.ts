/**
 * 配信スケジュール (settings.scheduleDaysOfWeek + scheduleHourJst) と
 * 現在 JST 時刻を照合する純粋関数。
 *
 * 設計仕様書 §3.2、FR-2、AC-6 / AC-7 に対応。
 *
 * Cloud Scheduler は毎時 JST 00 分起動 (`time-zone: Asia/Tokyo`) で固定だが、
 * 配信スケジュールの柔軟性 (曜日 + 時刻) は DB 設定値で実現する。
 * 本関数は cron 起動時に「今が配信時刻か」を判定するためだけに使う純粋関数。
 *
 * JST は固定 UTC+9 (DST なし、ADR-029)。
 *
 * @param settings 配信設定
 * @param now 現在時刻 (UTC、Date 型)。テストで固定できるよう注入可能
 * @returns true なら配信処理を実行、false なら何もしない (200 で即終了)
 */

import { JST_OFFSET_MS, type DispatchSettings } from "@lms-279/shared-types";

export function shouldRunNow(settings: DispatchSettings, now: Date): boolean {
  // kill switch (AC-7)
  if (!settings.enabled) return false;

  // 空配列なら常に false (誤発火防止)
  if (settings.scheduleDaysOfWeek.length === 0) return false;

  // JST 換算 (UTC + 9 時間)
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const jstDayOfWeek = jst.getUTCDay(); // JST 換算後の値を getUTCDay で取り出す
  const jstHour = jst.getUTCHours();

  // 曜日一致 (AC-6)
  if (!settings.scheduleDaysOfWeek.includes(jstDayOfWeek)) return false;

  // 時刻一致 (時単位、分は無視)
  if (jstHour !== settings.scheduleHourJst) return false;

  return true;
}
