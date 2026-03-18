"use client";

import { useEffect, useState, useCallback, Fragment } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { cn } from "@/lib/utils";

// ─── 型定義 ───────────────────────────────────────────────────────

type Course = {
  id: string;
  title: string;
};

type User = {
  id: string;
  name: string;
  email: string;
};

type CourseProgressEnrollment = {
  userId: string;
  name: string;
  email: string;
  completedLessons: number;
  totalLessons: number;
  progressRate: number; // 0〜100
  completed: boolean;
};

type CourseProgressData = {
  courseId: string;
  courseTitle: string;
  totalEnrollments: number;
  completedCount: number;
  averageProgressRate: number;
  enrollments: CourseProgressEnrollment[];
};

type LessonProgress = {
  lessonId: string;
  lessonTitle: string;
  videoCompleted: boolean;
  quizPassed: boolean;
};

type UserCourseProgress = {
  courseId: string;
  courseTitle: string;
  completedLessons: number;
  totalLessons: number;
  progressRate: number;
  completed: boolean;
  lessons?: LessonProgress[];
};

type UserProgressData = {
  userId: string;
  userName: string;
  courses: UserCourseProgress[];
};

type SuspiciousFlag =
  | "excessive_seeks"
  | "no_pauses_long_session"
  | "background_playback"
  | "speed_violation"
  | "position_jump";

const FLAG_LABELS: Record<SuspiciousFlag, string> = {
  excessive_seeks: "過度なシーク",
  no_pauses_long_session: "一時停止なし長時間視聴",
  background_playback: "バックグラウンド再生",
  speed_violation: "倍速違反",
  position_jump: "不自然な位置移動",
};

type SuspiciousViewingRecord = {
  id: string;
  userName: string;
  videoTitle: string;
  lessonTitle: string;
  coverageRate: number;
  seekCount: number;
  speedViolationCount: number;
  flags: SuspiciousFlag[];
};

type SuspiciousViewingData = {
  records: SuspiciousViewingRecord[];
};

// ─── 汎用コンポーネント ──────────────────────────────────────────

function LoadingState() {
  return <p className="text-muted-foreground text-sm">読み込み中...</p>;
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
      {message}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border p-8 text-center text-muted-foreground text-sm">
      {message}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded-full bg-secondary overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-8 text-right">
        {Math.round(pct)}%
      </span>
    </div>
  );
}

// ─── タブ1: コース別進捗 ─────────────────────────────────────────

function CourseProgressTab() {
  const { authFetch } = useAuthenticatedFetch();

  const [courses, setCourses] = useState<Course[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(true);
  const [coursesError, setCoursesError] = useState<string | null>(null);

  const [selectedCourseId, setSelectedCourseId] = useState<string>("");
  const [progressData, setProgressData] = useState<CourseProgressData | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);

  const [exportLoading, setExportLoading] = useState(false);

  // コース一覧取得
  useEffect(() => {
    let cancelled = false;
    setCoursesLoading(true);
    setCoursesError(null);
    authFetch<{ courses: Course[] }>("/api/v1/admin/courses")
      .then((data) => {
        if (!cancelled) setCourses(data.courses ?? []);
      })
      .catch((e) => {
        if (!cancelled)
          setCoursesError(e instanceof Error ? e.message : "コースの取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setCoursesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  // コース選択時に進捗取得
  const fetchProgress = useCallback(
    async (courseId: string) => {
      if (!courseId) return;
      setProgressLoading(true);
      setProgressError(null);
      setProgressData(null);
      try {
        const data = await authFetch<CourseProgressData>(
          `/api/v1/admin/analytics/courses/${courseId}/progress`
        );
        setProgressData(data);
      } catch (e) {
        setProgressError(e instanceof Error ? e.message : "進捗の取得に失敗しました");
      } finally {
        setProgressLoading(false);
      }
    },
    [authFetch]
  );

  const handleCourseChange = (courseId: string) => {
    setSelectedCourseId(courseId);
    fetchProgress(courseId);
  };

  // CSV エクスポート（認証付きblobダウンロード）
  const handleExport = useCallback(async () => {
    if (!selectedCourseId) return;
    setExportLoading(true);
    try {
      const blob = await authFetch<Blob>(
        `/api/v1/admin/analytics/export/courses/${selectedCourseId}`,
        { headers: { Accept: "text/csv" } }
      );
      const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([JSON.stringify(blob)]));
      const a = document.createElement("a");
      a.href = url;
      a.download = "progress.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("CSVエクスポートに失敗しました", e);
    } finally {
      setExportLoading(false);
    }
  }, [authFetch, selectedCourseId]);

  return (
    <div className="space-y-6">
      {/* コース選択 */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="w-72">
          {coursesLoading ? (
            <LoadingState />
          ) : coursesError ? (
            <ErrorState message={coursesError} />
          ) : (
            <Select value={selectedCourseId} onValueChange={handleCourseChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="コースを選択してください" />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {selectedCourseId && progressData && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exportLoading}
          >
            {exportLoading ? "エクスポート中..." : "CSVエクスポート"}
          </Button>
        )}
      </div>

      {/* 進捗データ */}
      {!selectedCourseId ? (
        <EmptyState message="コースを選択すると受講者の進捗が表示されます" />
      ) : progressLoading ? (
        <LoadingState />
      ) : progressError ? (
        <ErrorState message={progressError} />
      ) : progressData ? (
        <div className="space-y-6">
          {/* サマリーカード */}
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-md border p-4 space-y-1">
              <p className="text-xs text-muted-foreground">受講者数</p>
              <p className="text-2xl font-bold">{progressData.totalEnrollments}</p>
            </div>
            <div className="rounded-md border p-4 space-y-1">
              <p className="text-xs text-muted-foreground">完了者数</p>
              <p className="text-2xl font-bold">{progressData.completedCount}</p>
            </div>
            <div className="rounded-md border p-4 space-y-1">
              <p className="text-xs text-muted-foreground">平均進捗率</p>
              <p className="text-2xl font-bold">
                {Math.round(progressData.averageProgressRate)}%
              </p>
            </div>
          </div>

          {/* 受講者テーブル */}
          {progressData.enrollments.length === 0 ? (
            <EmptyState message="受講者がいません" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名前</TableHead>
                  <TableHead>メール</TableHead>
                  <TableHead>完了レッスン数</TableHead>
                  <TableHead>進捗率</TableHead>
                  <TableHead>状態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {progressData.enrollments.map((e) => (
                  <TableRow key={e.userId}>
                    <TableCell className="font-medium">{e.name}</TableCell>
                    <TableCell>{e.email}</TableCell>
                    <TableCell>
                      {e.completedLessons} / {e.totalLessons}
                    </TableCell>
                    <TableCell>
                      <ProgressBar value={e.progressRate} />
                    </TableCell>
                    <TableCell>
                      {e.completed ? (
                        <Badge variant="default">完了</Badge>
                      ) : (
                        <Badge variant="secondary">受講中</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── タブ2: ユーザー別進捗 ───────────────────────────────────────

function UserProgressTab() {
  const { authFetch } = useAuthenticatedFetch();

  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [progressData, setProgressData] = useState<UserProgressData | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);

  // 展開中コースID管理
  const [expandedCourseIds, setExpandedCourseIds] = useState<Set<string>>(new Set());

  // ユーザー一覧取得
  useEffect(() => {
    let cancelled = false;
    setUsersLoading(true);
    setUsersError(null);
    authFetch<{ users: User[] }>("/api/v1/admin/users")
      .then((data) => {
        if (!cancelled) setUsers(data.users ?? []);
      })
      .catch((e) => {
        if (!cancelled)
          setUsersError(e instanceof Error ? e.message : "ユーザーの取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  // ユーザー選択時に進捗取得
  const handleUserChange = useCallback(
    async (userId: string) => {
      setSelectedUserId(userId);
      setExpandedCourseIds(new Set());
      if (!userId) return;
      setProgressLoading(true);
      setProgressError(null);
      setProgressData(null);
      try {
        const data = await authFetch<UserProgressData>(
          `/api/v1/admin/analytics/users/${userId}/progress`
        );
        setProgressData(data);
      } catch (e) {
        setProgressError(e instanceof Error ? e.message : "進捗の取得に失敗しました");
      } finally {
        setProgressLoading(false);
      }
    },
    [authFetch]
  );

  const toggleCourse = (courseId: string) => {
    setExpandedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) {
        next.delete(courseId);
      } else {
        next.add(courseId);
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* ユーザー選択 */}
      <div className="w-72">
        {usersLoading ? (
          <LoadingState />
        ) : usersError ? (
          <ErrorState message={usersError} />
        ) : (
          <Select value={selectedUserId} onValueChange={handleUserChange}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="ユーザーを選択してください" />
            </SelectTrigger>
            <SelectContent>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}（{u.email}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* 進捗データ */}
      {!selectedUserId ? (
        <EmptyState message="ユーザーを選択するとコース別進捗が表示されます" />
      ) : progressLoading ? (
        <LoadingState />
      ) : progressError ? (
        <ErrorState message={progressError} />
      ) : progressData ? (
        progressData.courses.length === 0 ? (
          <EmptyState message="受講中のコースがありません" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>コース名</TableHead>
                <TableHead>完了レッスン数</TableHead>
                <TableHead>進捗率</TableHead>
                <TableHead>状態</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {progressData.courses.map((course) => (
                <Fragment key={course.courseId}>
                  <TableRow>
                    <TableCell className="font-medium">{course.courseTitle}</TableCell>
                    <TableCell>
                      {course.completedLessons} / {course.totalLessons}
                    </TableCell>
                    <TableCell>
                      <ProgressBar value={course.progressRate} />
                    </TableCell>
                    <TableCell>
                      {course.completed ? (
                        <Badge variant="default">完了</Badge>
                      ) : (
                        <Badge variant="secondary">受講中</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {course.lessons && course.lessons.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleCourse(course.courseId)}
                        >
                          {expandedCourseIds.has(course.courseId) ? "▲ 閉じる" : "▼ レッスン"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>

                  {/* レッスン詳細行（展開時） */}
                  {expandedCourseIds.has(course.courseId) &&
                    course.lessons?.map((lesson) => (
                      <TableRow
                        key={`${course.courseId}-${lesson.lessonId}`}
                        className="bg-muted/30"
                      >
                        <TableCell className="pl-8 text-muted-foreground text-xs" colSpan={1}>
                          └ {lesson.lessonTitle}
                        </TableCell>
                        <TableCell colSpan={3}>
                          <div className="flex gap-2">
                            <Badge
                              variant={lesson.videoCompleted ? "default" : "outline"}
                              className="text-xs"
                            >
                              動画{lesson.videoCompleted ? "完了" : "未完了"}
                            </Badge>
                            <Badge
                              variant={lesson.quizPassed ? "default" : "outline"}
                              className="text-xs"
                            >
                              テスト{lesson.quizPassed ? "合格" : "未合格"}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </div>
  );
}

// ─── タブ3: 不審視聴 ─────────────────────────────────────────────

function SuspiciousViewingTab() {
  const { authFetch } = useAuthenticatedFetch();

  const [data, setData] = useState<SuspiciousViewingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch<SuspiciousViewingData>("/api/v1/admin/analytics/suspicious-viewing")
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "データの取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!data || data.records.length === 0) {
    return <EmptyState message="不審な視聴パターンは検出されていません" />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>ユーザー名</TableHead>
          <TableHead>動画 / レッスン名</TableHead>
          <TableHead>カバー率</TableHead>
          <TableHead>シーク回数</TableHead>
          <TableHead>倍速違反回数</TableHead>
          <TableHead>不審フラグ</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.records.map((rec) => (
          <TableRow key={rec.id}>
            <TableCell className="font-medium">{rec.userName}</TableCell>
            <TableCell>
              <div className="space-y-0.5">
                <p className="text-sm">{rec.videoTitle}</p>
                <p className="text-xs text-muted-foreground">{rec.lessonTitle}</p>
              </div>
            </TableCell>
            <TableCell>{Math.round(rec.coverageRate)}%</TableCell>
            <TableCell>{rec.seekCount}</TableCell>
            <TableCell>{rec.speedViolationCount}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {rec.flags.map((flag) => (
                  <Badge
                    key={flag}
                    variant="destructive"
                    className="text-xs"
                  >
                    {FLAG_LABELS[flag] ?? flag}
                  </Badge>
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── メインページ ────────────────────────────────────────────────

const TAB_ITEMS = [
  { value: "course-progress", label: "コース別進捗" },
  { value: "user-progress", label: "ユーザー別進捗" },
  { value: "suspicious-viewing", label: "不審視聴" },
] as const;

type TabValue = (typeof TAB_ITEMS)[number]["value"];

export default function AnalyticsPage() {
  const [activeTab, setActiveTab] = useState<TabValue>("course-progress");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">分析ダッシュボード</h1>
        <p className="text-sm text-muted-foreground mt-1">
          学習状況や動画視聴統計を確認できます。
        </p>
      </div>

      <Tabs.Root
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabValue)}
        className="space-y-6"
      >
        {/* タブリスト */}
        <Tabs.List className="flex gap-1 border-b">
          {TAB_ITEMS.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none",
                "text-muted-foreground hover:text-foreground",
                "data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-foreground data-[state=active]:-mb-px"
              )}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {/* タブコンテンツ */}
        <Tabs.Content value="course-progress" className="focus-visible:outline-none">
          <CourseProgressTab />
        </Tabs.Content>

        <Tabs.Content value="user-progress" className="focus-visible:outline-none">
          <UserProgressTab />
        </Tabs.Content>

        <Tabs.Content value="suspicious-viewing" className="focus-visible:outline-none">
          <SuspiciousViewingTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
