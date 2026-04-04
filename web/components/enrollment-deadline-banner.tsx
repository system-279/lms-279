"use client";

type DeadlineStatus = "normal" | "caution" | "warning" | "expired";

interface EnrollmentDeadlineInfo {
  quizAccessUntil: string;
  videoAccessUntil: string;
}

function getDaysRemaining(deadline: string): number {
  const now = new Date();
  const end = new Date(deadline);
  return Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function getStatus(days: number): DeadlineStatus {
  if (days <= 0) return "expired";
  if (days <= 7) return "warning";
  if (days <= 14) return "caution";
  return "normal";
}

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Tokyo",
  });
}

function daysLabel(days: number): string {
  if (days <= 0) return "期限切れ";
  return `残り${days}日`;
}

const STATUS_STYLES: Record<DeadlineStatus, { bg: string; text: string; border: string }> = {
  normal: { bg: "", text: "text-muted-foreground", border: "" },
  caution: { bg: "bg-yellow-50 dark:bg-yellow-950/20", text: "text-yellow-700 dark:text-yellow-400", border: "border-yellow-200 dark:border-yellow-800" },
  warning: { bg: "bg-orange-50 dark:bg-orange-950/20", text: "text-orange-700 dark:text-orange-400", border: "border-orange-200 dark:border-orange-800" },
  expired: { bg: "bg-destructive/10", text: "text-destructive", border: "border-destructive/20" },
};

/**
 * コース一覧ページ用: テスト期限・動画期限を表示するバナー
 */
export function EnrollmentDeadlineBanner({ setting }: { setting: EnrollmentDeadlineInfo }) {
  const quizDays = getDaysRemaining(setting.quizAccessUntil);
  const videoDays = getDaysRemaining(setting.videoAccessUntil);
  const quizStatus = getStatus(quizDays);
  const videoStatus = getStatus(videoDays);

  // 最も緊急度の高いステータスでバナー全体の色を決定
  const overallStatus = [quizStatus, videoStatus].includes("expired")
    ? "expired"
    : [quizStatus, videoStatus].includes("warning")
      ? "warning"
      : [quizStatus, videoStatus].includes("caution")
        ? "caution"
        : "normal";

  const styles = STATUS_STYLES[overallStatus];

  return (
    <div className={`rounded-lg border p-4 text-sm ${styles.bg} ${styles.border}`}>
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <DeadlineItem
          label="テスト受験期限"
          deadline={setting.quizAccessUntil}
          days={quizDays}
          status={quizStatus}
        />
        <DeadlineItem
          label="動画視聴期限"
          deadline={setting.videoAccessUntil}
          days={videoDays}
          status={videoStatus}
        />
      </div>
    </div>
  );
}

function DeadlineItem({
  label,
  deadline,
  days,
  status,
}: {
  label: string;
  deadline: string;
  days: number;
  status: DeadlineStatus;
}) {
  const styles = STATUS_STYLES[status];
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}:</span>
      <span className={status === "normal" ? "" : `font-medium ${styles.text}`}>
        {formatDeadline(deadline)}
      </span>
      {status !== "normal" && (
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${styles.bg} ${styles.text}`}>
          {daysLabel(days)}
        </span>
      )}
    </div>
  );
}

/**
 * レッスンページ用: 14日以内の場合のみ表示する警告バナー
 */
export function DeadlineWarningBanner({
  type,
  deadline,
}: {
  type: "quiz" | "video";
  deadline: string;
}) {
  const days = getDaysRemaining(deadline);
  const status = getStatus(days);

  // 通常時は非表示
  if (status === "normal") return null;
  // 期限切れは既存UIがあるので非表示
  if (status === "expired") return null;

  const styles = STATUS_STYLES[status];
  const label = type === "quiz" ? "テスト受験" : "動画視聴";

  return (
    <div className={`rounded-md border px-4 py-2 text-sm ${styles.bg} ${styles.border} ${styles.text}`}>
      {label}期限まであと<span className="font-bold">{days}日</span>
      <span className="ml-2 text-xs">（{formatDeadline(deadline)}まで）</span>
    </div>
  );
}
