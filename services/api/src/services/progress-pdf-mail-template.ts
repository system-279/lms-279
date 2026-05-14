/**
 * Phase 2: Gmail 下書きメール文面生成。
 *
 * Phase 1 の ProgressPdfData (受講者進捗集約データ) からメール件名・本文を組み立てる。
 * ADR-034 §4 のテンプレートに準拠する。
 *
 * JST 表示で統一する（ADR-029 タイムゾーン基準）。
 */

import type { Pace, ProgressPdfData } from "@lms-279/shared-types";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface MailTemplateInput {
  data: ProgressPdfData;
  /** 送信者表示名 (Firebase Auth displayName、なければ email) */
  senderName: string;
}

export interface MailTemplateOutput {
  subject: string;
  body: string;
}

/** ISO 文字列を JST の YYYY-MM-DD 表記に変換 */
function toJstDate(isoString: string): string {
  const utc = new Date(isoString);
  if (Number.isNaN(utc.getTime())) return "—";
  const jst = new Date(utc.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 全コース合計の進捗率を整数パーセントで返す (0-100) */
export function calculateOverallProgressPercent(data: ProgressPdfData): {
  percent: number;
  completedLessons: number;
  totalLessons: number;
} {
  let completed = 0;
  let total = 0;
  for (const course of data.courses) {
    completed += course.completedLessons;
    total += course.totalLessons;
  }
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { percent, completedLessons: completed, totalLessons: total };
}

/** 期限サマリー文を生成 (pace.status で分岐) */
export function formatDeadlineSummary(data: ProgressPdfData): string {
  const { pace, deadline } = data;
  const videoUntil = deadline.videoAccessUntil ? toJstDate(deadline.videoAccessUntil) : null;
  const quizUntil = deadline.quizAccessUntil ? toJstDate(deadline.quizAccessUntil) : null;

  switch (pace.status) {
    case "completed":
      return "全レッスン完了済み";
    case "expired_both":
      return "受講期限切れ";
    case "expired_video":
      return quizUntil
        ? `動画期限切れ (${quizUntil} までテスト受験可)`
        : "動画期限切れ";
    case "expired_quiz":
      return videoUntil
        ? `テスト期限切れ (${videoUntil} まで動画視聴可)`
        : "テスト期限切れ";
    case "ongoing": {
      const days = pace.remainingDays;
      if (videoUntil && quizUntil) {
        return `${videoUntil} / ${quizUntil} まで (残り ${days} 日)`;
      }
      const single = videoUntil ?? quizUntil ?? "—";
      return days != null ? `${single} まで (残り ${days} 日)` : `${single}`;
    }
  }
}

/** 推奨ペースサマリー文を生成 (pace.status で分岐) */
export function formatPaceSummary(pace: Pace): string {
  switch (pace.status) {
    case "completed":
      return "完了";
    case "expired_both":
      return "期限切れ (再計画が必要)";
    case "expired_video":
      return "動画期限切れ (テストのみ受験可)";
    case "expired_quiz":
      return pace.lessonsPerWeek != null
        ? `週 ${pace.lessonsPerWeek} レッスン (動画視聴のみ)`
        : "テスト期限切れ";
    case "ongoing":
      if (pace.lessonsPerWeek != null && pace.minutesPerDay != null) {
        return `週 ${pace.lessonsPerWeek} レッスン / 1 日あたり ${pace.minutesPerDay} 分`;
      }
      return "—";
  }
}

/**
 * メール件名・本文を組み立てる。
 *
 * ADR-034 §4 のテンプレートに準拠。スーパー管理者は Gmail UI で編集可能。
 */
export function buildMailTemplate(input: MailTemplateInput): MailTemplateOutput {
  const { data, senderName } = input;
  const userDisplay = data.user.name ?? data.user.email;
  const tenantName = data.tenant.name;
  const generatedDate = toJstDate(data.generatedAt);

  const progress = calculateOverallProgressPercent(data);
  const deadlineSummary = formatDeadlineSummary(data);
  const paceSummary = formatPaceSummary(data.pace);

  const subject = `【${tenantName}】${userDisplay} さんの受講進捗レポート (${generatedDate})`;

  // RFC 5322 準拠で CRLF を採用 (MIME 本文と整合)。Gmail UI 上では LF/CRLF どちらでも
  // 表示されるが、Content-Transfer-Encoding 系の処理で安全側に倒す。
  const body = [
    "お世話になっております。",
    "",
    `${tenantName} の ${userDisplay} さんの受講進捗レポートを作成しました。`,
    "PDF を添付しておりますのでご確認ください。",
    "",
    "【現在の状況】",
    `- 進捗率: ${progress.percent}% (${progress.completedLessons}/${progress.totalLessons} レッスン完了)`,
    `- 受講期限: ${deadlineSummary}`,
    `- 推奨ペース: ${paceSummary}`,
    "",
    "ご質問やご相談がありましたら、本メールにご返信ください。",
    "",
    senderName,
  ].join("\r\n");

  return { subject, body };
}

export const __internal = { toJstDate };
