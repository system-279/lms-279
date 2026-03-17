"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, Circle, Clock } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useTenant } from "@/lib/tenant-context";

type Lesson = {
  id: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
};

type Course = {
  id: string;
  name: string;
  description: string;
  status: string;
  lessons?: Lesson[];
};

type LessonProgress = {
  lessonId: string;
  videoCompleted: boolean;
  quizPassed: boolean;
  lessonCompleted: boolean;
};

type CourseProgressData = {
  courseProgress?: {
    completedLessonCount: number;
    totalLessonCount: number;
    progressRatio: number;
    courseCompleted: boolean;
  };
  lessonProgresses?: LessonProgress[];
};

function LessonStatusIcon({ progress }: { progress: LessonProgress | undefined }) {
  if (!progress) {
    return <Circle className="w-5 h-5 text-muted-foreground/40" />;
  }
  if (progress.lessonCompleted) {
    return <CheckCircle className="w-5 h-5 text-green-600" />;
  }
  // Has some progress but not completed
  if (progress.videoCompleted || progress.quizPassed) {
    return <Clock className="w-5 h-5 text-yellow-500" />;
  }
  return <Circle className="w-5 h-5 text-muted-foreground/40" />;
}

function LessonStatusText({ progress }: { progress: LessonProgress | undefined }) {
  if (!progress) {
    return <span className="text-muted-foreground text-sm">未開始</span>;
  }
  if (progress.lessonCompleted) {
    return <span className="text-green-600 text-sm font-medium">完了</span>;
  }
  if (progress.videoCompleted || progress.quizPassed) {
    return <span className="text-yellow-600 text-sm">進行中</span>;
  }
  return <span className="text-muted-foreground text-sm">未開始</span>;
}

export default function StudentCourseDetailPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const { tenantId } = useTenant();
  const { authFetch } = useAuthenticatedFetch();

  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [progressData, setProgressData] = useState<CourseProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCourse = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<{ course: Course; lessons: Lesson[] }>(`/api/v1/courses/${courseId}`);
      setCourse(data.course);
      if (data.lessons) {
        const sorted = [...data.lessons].sort((a, b) => a.order - b.order);
        setLessons(sorted);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "講座の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch, courseId]);

  const fetchProgress = useCallback(async () => {
    try {
      const data = await authFetch<CourseProgressData>(
        `/api/v1/courses/${courseId}/progress`
      );
      setProgressData(data);
    } catch {
      // 進捗取得失敗はサイレント（メイン機能ではない）
    }
  }, [authFetch, courseId]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse]);

  useEffect(() => {
    fetchProgress();
  }, [fetchProgress]);

  const cp = progressData?.courseProgress ?? null;
  const lessonProgressMap = new Map<string, LessonProgress>(
    (progressData?.lessonProgresses ?? []).map((lp) => [lp.lessonId, lp])
  );
  const progressPercent = cp ? Math.round(cp.progressRatio * 100) : 0;
  const isCourseCompleted = cp?.courseCompleted ?? false;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href={`/${tenantId}/student/courses`} className="hover:text-foreground">
          講座一覧
        </Link>
        <span>/</span>
        <span className="text-foreground">{course?.name ?? "読み込み中..."}</span>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : !course ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          講座が見つかりません
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <h1 className="text-2xl font-bold">{course.name}</h1>
              {isCourseCompleted && (
                <Badge className="mt-1 flex-shrink-0 bg-green-600 hover:bg-green-600 text-white">
                  コース完了
                </Badge>
              )}
            </div>
            {course.description && (
              <p className="text-muted-foreground whitespace-pre-wrap">{course.description}</p>
            )}

            {/* コース全体の進捗バー */}
            {cp != null && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {cp.completedLessonCount}/{cp.totalLessonCount} レッスン完了
                  </span>
                  <span className="font-medium">{progressPercent}%</span>
                </div>
                <div className="w-full bg-secondary rounded-full h-2.5 overflow-hidden">
                  <div
                    className={`h-2.5 rounded-full transition-all duration-500 ${
                      isCourseCompleted ? "bg-green-500" : "bg-primary"
                    }`}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <h2 className="text-lg font-semibold">レッスン一覧</h2>
            {lessons.length === 0 ? (
              <div className="rounded-md border p-8 text-center text-muted-foreground">
                レッスンがまだありません
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>タイトル</TableHead>
                    <TableHead>動画</TableHead>
                    <TableHead>クイズ</TableHead>
                    <TableHead>進捗</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lessons.map((lesson, index) => {
                    const lp = lessonProgressMap.get(lesson.id);
                    return (
                      <TableRow
                        key={lesson.id}
                        className="cursor-pointer hover:bg-secondary/50"
                        onClick={() => {
                          window.location.href = `/${tenantId}/student/courses/${courseId}/lessons/${lesson.id}`;
                        }}
                      >
                        <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                        <TableCell className="font-medium">{lesson.title}</TableCell>
                        <TableCell>
                          {lesson.hasVideo ? (
                            <Badge variant="secondary">あり</Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">なし</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {lesson.hasQuiz ? (
                            <Badge variant="secondary">あり</Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">なし</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <LessonStatusIcon progress={lp} />
                            <LessonStatusText progress={lp} />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
