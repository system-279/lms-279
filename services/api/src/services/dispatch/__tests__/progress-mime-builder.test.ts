/**
 * progress-mime-builder.ts の単体テスト (TDD)。
 *
 * 設計仕様書 Phase 3 PR 3c / AC-PR-12 / AC-PR-14 対応。
 *
 * 観点:
 *   - PDF buffer + ProgressPdfData → raw MIME (multipart/mixed) 組立成功
 *   - subject / body / attachmentFilename が caller に返る
 *   - CC 空配列で Cc ヘッダ省略
 *   - 日本語ファイル名 (受講者名) で RFC 2231 dual-form
 *   - boundary 固定 (テスト再現性)
 *   - ccNoteEmail 設定時は本文末に注記、未設定時は注記省略
 *   - 巨大 PDF (1MB) でも raw 組立成功 (size 上限は caller 責務、本関数は build のみ)
 *   - 境界: 0byte PDF buffer → 添付 part の base64 が空文字、構造的に有効
 *   - filename injection: pdfData.user.name に `"` 注入は buildMessageMime で reject される
 */

import { describe, it, expect } from "vitest";
import type { ProgressPdfData } from "@lms-279/shared-types";
import { buildProgressReportMime } from "../progress-mime-builder.js";

function makePdfData(overrides?: Partial<ProgressPdfData>): ProgressPdfData {
  const base: ProgressPdfData = {
    generatedAt: "2026-06-03T03:00:00.000Z", // JST: 2026-06-03 12:00
    user: { id: "u1", name: "山田 太郎", email: "yamada@example.com" },
    tenant: { id: "t1", name: "サンプルテナント", ownerEmail: "owner@example.com" },
    deadline: {
      enrolledAt: "2026-04-01T00:00:00.000Z",
      deadlineBaseDate: "2026-04-01",
      videoAccessUntil: "2026-06-30T14:59:59.000Z",
      quizAccessUntil: "2026-07-31T14:59:59.000Z",
      daysRemainingVideo: 27,
      daysRemainingQuiz: 58,
    },
    courses: [
      {
        courseId: "c1",
        courseName: "コース 1",
        completedLessons: 3,
        totalLessons: 10,
        progressRatio: 0.3,
        isCompleted: false,
        lessons: [],
      },
    ],
    pace: {
      status: "ongoing",
      remainingLessons: 7,
      remainingDays: 27,
      lessonsPerWeek: 2,
      minutesPerDay: 30,
    },
    videoSummary: { totalWatchedSec: 1800, totalDurationSec: 6000 },
  };
  return { ...base, ...overrides };
}

function decodeRawMime(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf-8");
}

const FIXED_BOUNDARY = "boundary_test_fixed_3c";
const PDF_BUFFER = Buffer.from("%PDF-1.4 fake pdf content");
const FROM_EMAIL = "dxcollege@279279.net";
const TO_EMAIL = "student@example.com";
const SENDER_NAME = "DXcollege運営スタッフ";

describe("buildProgressReportMime — 基本構造 (AC-PR-12)", () => {
  it("multipart/mixed + boundary が Content-Type ヘッダに含まれる", () => {
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(decoded).toContain(
      `Content-Type: multipart/mixed; boundary="${FIXED_BOUNDARY}"`,
    );
    expect(decoded).toContain(`--${FIXED_BOUNDARY}`);
    expect(decoded).toContain(`--${FIXED_BOUNDARY}--`); // closing boundary
  });

  it("text/plain part と application/pdf part が両方含まれる", () => {
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(decoded).toContain("Content-Type: application/pdf");
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
  });

  it("From / To / Subject ヘッダが含まれる", () => {
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(decoded).toContain(`From: ${FROM_EMAIL}`);
    expect(decoded).toContain(`To: ${TO_EMAIL}`);
    expect(decoded).toMatch(/^Subject:.*/m);
  });
});

describe("buildProgressReportMime — CC 制御", () => {
  it("ccEmails 空配列なら Cc ヘッダ省略 (gmail-dwd-send 既存挙動)", () => {
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(decoded).not.toMatch(/^Cc:/m);
  });

  it("ccEmails 1 件で Cc ヘッダに include", () => {
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: ["owner@example.com"],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(decoded).toContain("Cc: owner@example.com");
  });

  it("ccEmails 複数件で Cc にカンマ区切り", () => {
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: ["owner@example.com", "manager@example.com"],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(decoded).toContain("Cc: owner@example.com, manager@example.com");
  });
});

describe("buildProgressReportMime — 添付ファイル名 (AC-PR-12 dual-form)", () => {
  it("日本語名 → RFC 2231 dual-form (filename + filename*=UTF-8'')", () => {
    const { raw, attachmentFilename } = buildProgressReportMime({
      pdfData: makePdfData({
        user: { id: "u1", name: "山田 太郎", email: "yamada@example.com" },
      }),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    // attachmentFilename は日本語名を含む (Issue #366 修正済 buildProgressPdfFilename)
    expect(attachmentFilename).toContain("山田 太郎");
    // raw MIME は dual-form
    expect(decoded).toContain("filename=");
    expect(decoded).toContain("filename*=UTF-8''");
  });

  it("ASCII 名 → filename=\"...\" のみ (filename* なし)", () => {
    const { raw, attachmentFilename } = buildProgressReportMime({
      pdfData: makePdfData({
        user: { id: "u1", name: "John", email: "john@example.com" },
      }),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(attachmentFilename).toContain("John");
    expect(decoded).toContain(`filename="${attachmentFilename}"`);
    expect(decoded).not.toContain("filename*=UTF-8''");
  });

  it("ファイル名に generatedAt 由来の日付 (YYYY-MM-DD) を含む", () => {
    const { attachmentFilename } = buildProgressReportMime({
      pdfData: makePdfData({ generatedAt: "2026-06-03T03:00:00.000Z" }),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    expect(attachmentFilename).toContain("2026-06-03");
  });
});

describe("buildProgressReportMime — subject / body 構築 (buildMailTemplate 委譲)", () => {
  it("subject に tenant 名 + 受講者名 + 日付 (JST) を含む", () => {
    const { subject } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    expect(subject).toContain("サンプルテナント");
    expect(subject).toContain("山田 太郎");
    expect(subject).toContain("2026-06-03"); // JST date
  });

  it("body に進捗率 + 受講期限 + ペースを含む", () => {
    const { body } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    expect(body).toContain("進捗率: 30%"); // 3/10
    expect(body).toContain("受講期限");
    expect(body).toContain("推奨ペース");
  });

  it("ccNoteEmail 設定時、本文に CC 注記を含む", () => {
    const { body } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: ["owner@example.com"],
      senderName: SENDER_NAME,
      ccNoteEmail: "owner@example.com",
      boundary: FIXED_BOUNDARY,
    });
    expect(body).toContain("owner@example.com");
    expect(body).toContain("CC でお送りしています");
  });

  it("ccNoteEmail 未指定なら本文に CC 注記を含まない", () => {
    const { body } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    expect(body).not.toContain("CC でお送りしています");
  });

  it("body 末尾に senderName を含む (署名)", () => {
    const { body } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: "テスト署名",
      boundary: FIXED_BOUNDARY,
    });
    expect(body).toContain("テスト署名");
  });
});

describe("buildProgressReportMime — PDF buffer サイズ", () => {
  it("1MB PDF でも raw 組立成功 (size 上限は caller 責務)", () => {
    const oneMb = Buffer.alloc(1024 * 1024, 0x41); // 1MB の 'A'
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: oneMb,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    // base64 encoded 1MB は約 1.33MB → 全体 raw も十分大きい
    expect(decoded.length).toBeGreaterThan(1024 * 1024);
    expect(decoded).toContain("Content-Type: application/pdf");
  });

  it("0byte PDF buffer でも構造的に有効 (添付 part の base64 が空文字)", () => {
    const empty = Buffer.alloc(0);
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: empty,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    const decoded = decodeRawMime(raw);
    expect(decoded).toContain("Content-Type: application/pdf");
    // closing boundary が末尾に正しく出る
    expect(decoded).toMatch(new RegExp(`--${FIXED_BOUNDARY}--$`));
  });
});

describe("buildProgressReportMime — boundary 自動生成", () => {
  it("boundary 未指定なら gmail-dwd-send が generate (boundary_<32 hex>)", () => {
    const { raw } = buildProgressReportMime({
      pdfData: makePdfData(),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      // boundary 未指定
    });
    const decoded = decodeRawMime(raw);
    // boundary_<hex> パターン
    expect(decoded).toMatch(
      /Content-Type: multipart\/mixed; boundary="boundary_[0-9a-f]{32}"/,
    );
  });
});

describe("buildProgressReportMime — 防御層 (gmail-dwd-send への委譲)", () => {
  it("fromEmail 空文字 → throw (gmail-dwd-send assertHeaderSafe 反映)", () => {
    expect(() =>
      buildProgressReportMime({
        pdfData: makePdfData(),
        pdfBuffer: PDF_BUFFER,
        fromEmail: "",
        toEmail: TO_EMAIL,
        ccEmails: [],
        senderName: SENDER_NAME,
        boundary: FIXED_BOUNDARY,
      }),
    ).toThrow(/fromEmail/);
  });

  it("toEmail に CR/LF 注入 → throw (header injection 防御)", () => {
    expect(() =>
      buildProgressReportMime({
        pdfData: makePdfData(),
        pdfBuffer: PDF_BUFFER,
        fromEmail: FROM_EMAIL,
        toEmail: "student@example.com\r\nBcc: attacker@example.com",
        ccEmails: [],
        senderName: SENDER_NAME,
        boundary: FIXED_BOUNDARY,
      }),
    ).toThrow(/CR\/LF/);
  });

  it("pdfData.user.name の `\"` は buildProgressPdfFilename で sanitize、raw MIME に到達しない", () => {
    const { raw, attachmentFilename } = buildProgressReportMime({
      pdfData: makePdfData({
        user: { id: "u1", name: 'attacker"; X-Injected: 1', email: "a@example.com" },
      }),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    // buildProgressPdfFilename は OS / HTTP unsafe な `/ \ : * ? " < > |` を除去
    // (`packages/shared-types/src/filename.ts` docstring に明記済) → filename に `"` 不在
    expect(attachmentFilename).not.toContain('"');
    // 万一の二段階防御 (gmail-dwd-send) も sanity check として確認: filename に `"` 不在で
    // Content-Disposition の quoted-string parameter は破綻しない
    const decoded = decodeRawMime(raw);
    expect(decoded).not.toMatch(/filename="[^"]*"[^;\r\n]+="/);
  });

  it("pdfData.user.name に CR/LF 注入 → buildProgressPdfFilename で除去、subject にも残らない", () => {
    const { subject, attachmentFilename } = buildProgressReportMime({
      pdfData: makePdfData({
        user: { id: "u1", name: "attacker\r\nBcc: hacker@example.com", email: "a@example.com" },
      }),
      pdfBuffer: PDF_BUFFER,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      ccEmails: [],
      senderName: SENDER_NAME,
      boundary: FIXED_BOUNDARY,
    });
    expect(attachmentFilename).not.toMatch(/[\r\n]/);
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
