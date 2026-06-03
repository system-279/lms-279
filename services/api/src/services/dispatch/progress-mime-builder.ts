/**
 * 進捗レポート定期自動配信用 multipart/mixed MIME 組立 (Phase 3 PR 3c、ADR-039)。
 *
 * 設計仕様書 §4.1 / AC-PR-12 / AC-PR-13 / AC-PR-14:
 *   - subject / body: progress-pdf-mail-template.ts (buildMailTemplate) を流用
 *   - filename: shared-types `buildProgressPdfFilename` を流用 (Issue #366 修正済)
 *   - raw MIME: gmail-dwd-send.ts `buildMessageMime` を呼ぶ (multipart/mixed)
 *
 * 本ファイルの責務は「PDF buffer + ProgressPdfData + sender 情報を受け取り、
 * Gmail API users.messages.send に渡す raw 文字列まで組み立てる」thin facade。
 * PDF 生成 (buildProgressPdfData / ProgressPdfDocument renderToBuffer) と
 * 5MB 上限チェックは caller (run-progress-reports.ts) の責務。
 *
 * 非責務:
 *   - PDF 生成 / Buffer alloc (caller)
 *   - PDF サイズ判定 (AC-PR-13、caller 側で `PROGRESS_REPORT_PDF_MAX_BYTES` と比較して skip)
 *   - PII hash 化 (caller、markProgressRecipientSent 時点で渡す)
 *   - Gmail API 呼び出し (gmail-dwd-send.ts)
 */

import {
  buildProgressPdfFilename,
  type ProgressPdfData,
} from "@lms-279/shared-types";

import { buildMessageMime } from "./gmail-dwd-send.js";
import { buildMailTemplate } from "../progress-pdf-mail-template.js";

export interface BuildProgressReportMimeInput {
  /** 受講者進捗集約データ (buildProgressPdfData の出力) */
  pdfData: ProgressPdfData;
  /** PDF 生成済み Buffer (renderToBuffer の出力。サイズ上限チェック済) */
  pdfBuffer: Buffer;
  /** MIME From (SendAs alias、`DXCOLLEGE_SENDER_EMAIL` env) */
  fromEmail: string;
  /** To (受講者本人) */
  toEmail: string;
  /** Cc 配列 (cc-email-validator で validate + dedup 済)。空配列なら Cc ヘッダ省略 */
  ccEmails: readonly string[];
  /** 本文の送信者署名 (`signatureName` 等、settings から渡される) */
  senderName: string;
  /**
   * 本文末に「CC でお送りしています」注記を追加するためのテナント担当者 email。
   * undefined / 空文字 (trim 後) なら注記省略 (buildMailTemplate の挙動に合わせる)。
   * 通常は CC の代表 1 件 (テナント ownerEmail) を渡す。
   */
  ccNoteEmail?: string;
  /** boundary を固定する場合 (主にテスト用)。未指定時は buildMessageMime が生成 */
  boundary?: string;
}

export interface BuildProgressReportMimeOutput {
  /** Gmail API users.messages.send の raw フィールド (base64url) */
  raw: string;
  /** 送信件名 (audit 用に caller が参照可能) */
  subject: string;
  /** 送信本文 (audit / 障害調査用) */
  body: string;
  /** 添付 PDF のファイル名 (Content-Disposition の filename、RFC 2231 dual-form 前) */
  attachmentFilename: string;
}

const PDF_CONTENT_TYPE = "application/pdf";

/**
 * 進捗レポート用の raw MIME (multipart/mixed) を組み立てる。
 *
 * 流れ:
 *   1. buildMailTemplate(pdfData, senderName, ccNoteEmail) → subject + body
 *   2. buildProgressPdfFilename({name, email, date: pdfData.generatedAt slice 10}) → filename
 *   3. buildMessageMime({fromEmail, to, cc, subject, body, attachments: [...]}) → raw
 *
 * 注: buildMessageMime は filename の `"` / `\` / contentType の RFC 6838 違反を
 * 内部で reject する (Phase 3 PR 3b security review 反映)。buildProgressPdfFilename は
 * これらの記号を sanitize しないため、Gmail API 拒否の前段で本関数の caller も
 * filename を信頼しないこと (テスト時固定 fixture で `"` を含めると throw)。
 */
export function buildProgressReportMime(
  input: BuildProgressReportMimeInput,
): BuildProgressReportMimeOutput {
  const {
    pdfData,
    pdfBuffer,
    fromEmail,
    toEmail,
    ccEmails,
    senderName,
    ccNoteEmail,
    boundary,
  } = input;

  const template = buildMailTemplate({
    data: pdfData,
    senderName,
    ccEmail: ccNoteEmail,
  });

  // generatedAt は ISO 8601 (UTC) のため slice(0,10) で YYYY-MM-DD を取り出す。
  // mail template 内では JST 換算を行うが、ファイル名は UTC 由来でも一意性は担保される
  // (ADR-029 タイムゾーン基準、Issue #366 既存挙動と同等)。
  const dateStr = pdfData.generatedAt.slice(0, 10);
  const attachmentFilename = buildProgressPdfFilename({
    name: pdfData.user.name,
    email: pdfData.user.email,
    date: dateStr,
  });

  const raw = buildMessageMime({
    fromEmail,
    to: toEmail,
    cc: ccEmails,
    subject: template.subject,
    body: template.body,
    attachments: [
      {
        filename: attachmentFilename,
        contentType: PDF_CONTENT_TYPE,
        data: pdfBuffer,
      },
    ],
    ...(boundary !== undefined && { boundary }),
  });

  return {
    raw,
    subject: template.subject,
    body: template.body,
    attachmentFilename,
  };
}
