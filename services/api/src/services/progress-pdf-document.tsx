/**
 * @react-pdf/renderer による進捗 PDF Document コンポーネント。
 *
 * 7 セクション（profile / deadline / summary / lessons / quiz / pace / video）を
 * `sections` フラグでトグル可能。Noto Sans JP を Font.register して日本語表示。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, Font, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type {
  Pace,
  ProgressPdfCourseRecord,
  ProgressPdfData,
  ProgressPdfSections,
} from "@lms-279/shared-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dist/services/progress-pdf-document.js から ../../assets/fonts/... へ辿る。
// src 実行時（vitest 等）は services/api/src/services/... → ../../assets/fonts/... で同じく解決。
const FONT_PATH = path.resolve(__dirname, "../../assets/fonts/NotoSansJP-VariableFont.ttf");

let fontRegistered = false;
function ensureFontRegistered() {
  if (fontRegistered) return;
  Font.register({
    family: "NotoSansJP",
    fonts: [
      { src: FONT_PATH, fontWeight: 400 },
      { src: FONT_PATH, fontWeight: 700 },
    ],
  });
  // 改行制御: @react-pdf/renderer はデフォルトで latin の境界しか改行しない。
  Font.registerHyphenationCallback((word) => Array.from(word));
  fontRegistered = true;
}

// 本文 / 副次情報 / 構造線 のコントラスト階層 (印刷時の視認性を確保)
const COLOR_BODY = "#000000"; // 本文 (純黒、紙印刷で最大コントラスト)
const COLOR_SUB = "#374151"; // 副次情報 / ラベル (gray-700、本文との対比は維持しつつ十分な濃度)
const COLOR_BORDER = "#9ca3af"; // 構造線 (gray-400)

const styles = StyleSheet.create({
  page: { fontFamily: "NotoSansJP", fontSize: 10, padding: 32, color: COLOR_BODY },
  h1: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  h2: { fontSize: 13, fontWeight: 700, marginTop: 14, marginBottom: 6, borderBottom: 1, borderColor: COLOR_BORDER, paddingBottom: 2 },
  meta: { fontSize: 9, color: COLOR_SUB, marginBottom: 8 },
  row: { flexDirection: "row", marginBottom: 2 },
  label: { width: 100, color: COLOR_SUB },
  value: { flex: 1 },
  section: { marginBottom: 6 },
  courseHeader: { fontSize: 11, fontWeight: 700, marginTop: 8, marginBottom: 4 },
  progressBarOuter: { height: 6, backgroundColor: "#e5e7eb", borderRadius: 3, marginTop: 2, marginBottom: 4 },
  progressBarInner: { height: 6, backgroundColor: "#22c55e", borderRadius: 3 },
  lessonRow: { flexDirection: "row", marginBottom: 1.5, paddingVertical: 1 },
  lessonCheck: { width: 16, fontWeight: 700 },
  lessonTitle: { flex: 1 },
  lessonMeta: { width: 80, color: COLOR_SUB, fontSize: 9, textAlign: "right" },
  expired: { color: "#dc2626", fontWeight: 700 },
  caution: { color: "#f59e0b" },
});

function formatDate(iso: string | null): string {
  if (!iso) return "未設定";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // JST 日付表示
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm} JST`;
}

function formatDays(days: number | null): string {
  if (days == null) return "—";
  if (days < 0) return "期限切れ";
  if (days === 0) return "本日まで";
  return `あと ${days} 日`;
}

function formatHours(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 分";
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} 分`;
  return `${h} 時間 ${m} 分`;
}

function paceMessage(pace: Pace): { jp: string; tone: "normal" | "caution" | "expired" } {
  switch (pace.status) {
    case "completed":
      return { jp: "すべてのレッスンが完了しています。", tone: "normal" };
    case "expired_both":
      return { jp: "受講期限を過ぎています。事務局にご相談ください。", tone: "expired" };
    case "expired_video":
      return { jp: "動画視聴期限が終了しています（テスト受験のみ可能）。", tone: "expired" };
    case "expired_quiz":
      return { jp: "テスト受験期限が終了しています（動画視聴のみ可能）。", tone: "expired" };
    case "ongoing":
      return { jp: "このペースで進めていきましょう。", tone: "normal" };
  }
}

interface DocumentProps {
  data: ProgressPdfData;
  sections: ProgressPdfSections;
}

export function ProgressPdfDocument({ data, sections }: DocumentProps) {
  ensureFontRegistered();

  return (
    <Document
      title={`progress-${data.user.name ?? data.user.email}`}
      author="LMS-279 super admin"
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>受講進捗レポート</Text>
        <Text style={styles.meta}>
          {data.tenant.name}  /  発行日: {formatDateTime(data.generatedAt)}
        </Text>

        {sections.profile && <ProfileSection data={data} />}
        {sections.deadline && <DeadlineSection data={data} />}
        {sections.summary && <SummarySection courses={data.courses} />}
        {sections.lessons && <LessonChecklistSection courses={data.courses} />}
        {sections.quiz && <QuizScoresSection courses={data.courses} />}
        {sections.pace && <PaceSection data={data} />}
        {sections.video && <VideoWatchTimeSection data={data} />}
      </Page>
    </Document>
  );
}

function ProfileSection({ data }: { data: ProgressPdfData }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>受講者プロフィール</Text>
      <View style={styles.row}>
        <Text style={styles.label}>氏名</Text>
        <Text style={styles.value}>{data.user.name ?? "(未設定)"}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>メール</Text>
        <Text style={styles.value}>{data.user.email}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>テナント</Text>
        <Text style={styles.value}>{data.tenant.name}</Text>
      </View>
    </View>
  );
}

function DeadlineSection({ data }: { data: ProgressPdfData }) {
  const { deadline } = data;
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>受講期限</Text>
      <View style={styles.row}>
        <Text style={styles.label}>受講開始日</Text>
        <Text style={styles.value}>{formatDate(deadline.enrolledAt)}</Text>
      </View>
      {deadline.deadlineBaseDate && (
        <View style={styles.row}>
          <Text style={styles.label}>期限起算日</Text>
          <Text style={styles.value}>{formatDate(deadline.deadlineBaseDate)}</Text>
        </View>
      )}
      <View style={styles.row}>
        <Text style={styles.label}>動画視聴期限</Text>
        <Text style={styles.value}>
          {formatDate(deadline.videoAccessUntil)}  ({formatDays(deadline.daysRemainingVideo)})
        </Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>テスト受験期限</Text>
        <Text style={styles.value}>
          {formatDate(deadline.quizAccessUntil)}  ({formatDays(deadline.daysRemainingQuiz)})
        </Text>
      </View>
    </View>
  );
}

function SummarySection({ courses }: { courses: ProgressPdfCourseRecord[] }) {
  if (courses.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.h2}>進捗サマリー</Text>
        <Text>受講中のコースがありません。</Text>
      </View>
    );
  }
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>進捗サマリー</Text>
      {courses.map((c) => {
        const pct = Math.round((c.progressRatio ?? 0) * 100);
        return (
          <View key={c.courseId}>
            <Text style={styles.courseHeader}>
              {c.courseName}  ({c.completedLessons}/{c.totalLessons} レッスン完了 — {pct}%)
            </Text>
            <View style={styles.progressBarOuter}>
              <View style={[styles.progressBarInner, { width: `${pct}%` }]} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function LessonChecklistSection({ courses }: { courses: ProgressPdfCourseRecord[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>レッスン別チェックリスト</Text>
      {courses.map((c) => (
        // コース全体での wrap={false} は大量レッスン時に行が消えるので使わず、
        // コースヘッダだけは次のレッスンと一緒に保つ。レッスン行は break-inside-avoid のみ。
        <View key={c.courseId}>
          <View wrap={false}>
            <Text style={styles.courseHeader}>{c.courseName}</Text>
          </View>
          {c.lessons.map((l) => {
            const mark = l.lessonCompleted
              ? "✓"
              : l.videoCompleted || l.quizPassed
              ? "△"
              : "□";
            const detail: string[] = [];
            if (l.hasVideo) detail.push(l.videoCompleted ? "動画✓" : "動画□");
            if (l.hasQuiz) detail.push(l.quizPassed ? "テスト✓" : "テスト□");
            return (
              <View key={l.lessonId} style={styles.lessonRow} wrap={false}>
                <Text style={styles.lessonCheck}>{mark}</Text>
                <Text style={styles.lessonTitle}>{l.lessonTitle}</Text>
                <Text style={styles.lessonMeta}>{detail.join(" / ")}</Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function QuizScoresSection({ courses }: { courses: ProgressPdfCourseRecord[] }) {
  const rows = courses.flatMap((c) =>
    c.lessons
      .filter((l) => l.hasQuiz)
      .map((l) => ({ courseName: c.courseName, lessonTitle: l.lessonTitle, score: l.quizBestScore, passed: l.quizPassed })),
  );
  if (rows.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.h2}>テスト成績</Text>
        <Text>テスト対象のレッスンはありません。</Text>
      </View>
    );
  }
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>テスト成績</Text>
      {rows.map((r, idx) => (
        <View key={`${r.courseName}-${idx}`} style={styles.lessonRow}>
          <Text style={styles.lessonCheck}>{r.passed ? "✓" : "□"}</Text>
          <Text style={styles.lessonTitle}>{r.courseName} / {r.lessonTitle}</Text>
          <Text style={styles.lessonMeta}>
            {r.score != null ? `${r.score}点` : "未受験"}
            {r.passed ? " 合格" : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PaceSection({ data }: { data: ProgressPdfData }) {
  const { pace } = data;
  const msg = paceMessage(pace);
  const toneStyle =
    msg.tone === "expired" ? styles.expired : msg.tone === "caution" ? styles.caution : undefined;
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>推奨ペース</Text>
      <Text style={toneStyle}>{msg.jp}</Text>
      <View style={styles.row}>
        <Text style={styles.label}>残りレッスン</Text>
        <Text style={styles.value}>{pace.remainingLessons} レッスン</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>残り日数</Text>
        <Text style={styles.value}>{formatDays(pace.remainingDays)}</Text>
      </View>
      {pace.lessonsPerWeek != null && (
        <View style={styles.row}>
          <Text style={styles.label}>週ペース</Text>
          <Text style={styles.value}>1週間あたり {pace.lessonsPerWeek} レッスン</Text>
        </View>
      )}
      {pace.minutesPerDay != null && (
        <View style={styles.row}>
          <Text style={styles.label}>1日あたり視聴</Text>
          <Text style={styles.value}>{pace.minutesPerDay} 分</Text>
        </View>
      )}
    </View>
  );
}

function VideoWatchTimeSection({ data }: { data: ProgressPdfData }) {
  const { totalWatchedSec, totalDurationSec } = data.videoSummary;
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>動画視聴時間</Text>
      <View style={styles.row}>
        <Text style={styles.label}>累計視聴</Text>
        <Text style={styles.value}>{formatHours(totalWatchedSec)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>全体長</Text>
        <Text style={styles.value}>{formatHours(totalDurationSec)}</Text>
      </View>
    </View>
  );
}
