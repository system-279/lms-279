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
  /**
   * CC 宛先 (テナント管理者 email)。設定済なら本文末に CC 共有の注記を追加する。
   * undefined / 空文字 (trim 後) なら注記を省略する。
   *
   * SECURITY: route 層で CRLF/カンマ/制御文字バリデーション済の値のみ受け付ける前提。
   * 本関数内でも stripCRLF で本文インジェクションを二重防御する。
   */
  ccEmail?: string;
}

export interface MailTemplateOutput {
  subject: string;
  body: string;
}

/**
 * 件名・本文に埋め込まれる前にユーザー由来文字列の CR/LF を空白へ。
 * SECURITY: tenant.name / user.name が件名行に入るため、CR/LF が残ると
 * MIME ヘッダインジェクション (Bcc 改ざん等) のリスク。route 層の二重防御。
 */
function stripCRLF(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
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
  const { data, senderName, ccEmail } = input;
  // SECURITY: 件名行・本文に注入される可能性のあるフィールドは CR/LF を除去 (空白置換)。
  const userDisplay = stripCRLF(data.user.name ?? data.user.email);
  const tenantName = stripCRLF(data.tenant.name);
  const safeSenderName = stripCRLF(senderName);
  const generatedDate = toJstDate(data.generatedAt);

  const progress = calculateOverallProgressPercent(data);
  const deadlineSummary = formatDeadlineSummary(data);
  const paceSummary = formatPaceSummary(data.pace);

  const subject = `【${tenantName}】${userDisplay} さんの受講進捗レポート (${generatedDate})`;

  // CC 注記は ownerEmail (= ccEmail) が実際に設定されているときのみ追加する
  // (未設定で省略しているのに「CC でお送りしています」と書くと本文が虚偽になる)。
  // stripCRLF は前後 trim を行うが、追加で .trim() でも防御し空白のみケースを確実に弾く。
  const normalizedCcEmail = typeof ccEmail === "string" ? stripCRLF(ccEmail).trim() : "";
  const ccNoteLines: string[] = normalizedCcEmail.length > 0
    ? [
        "",
        `※ ${tenantName} のご担当者様 (${normalizedCcEmail}) にも CC でお送りしています。`,
      ]
    : [];

  // RFC 5322 準拠で CRLF を採用 (MIME 本文と整合)。Gmail UI 上では LF/CRLF どちらでも
  // 表示されるが、Content-Transfer-Encoding 系の処理で安全側に倒す。
  // 二人称: 受講者本人宛 (To) であるため「{userName} 様」呼びかけに統一。
  const body = [
    `${userDisplay} 様`,
    "",
    "お世話になっております。",
    "",
    `${tenantName} での ${userDisplay} 様の受講進捗レポートをお送りいたします。`,
    "PDF を添付しておりますのでご確認ください。",
    "",
    "【現在の状況】",
    `- 進捗率: ${progress.percent}% (${progress.completedLessons}/${progress.totalLessons} レッスン完了)`,
    `- 受講期限: ${deadlineSummary}`,
    `- 推奨ペース: ${paceSummary}`,
    "",
    "ご質問やご相談がありましたら、本メールにご返信ください。",
    "",
    safeSenderName,
    ...ccNoteLines,
  ].join("\r\n");

  return { subject, body };
}

export const __internal = { toJstDate, stripCRLF };
