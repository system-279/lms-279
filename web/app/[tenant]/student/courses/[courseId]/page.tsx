"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
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

export default function StudentCourseDetailPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const { tenantId } = useTenant();
  const { authFetch } = useAuthenticatedFetch();

  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCourse = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<{ course: Course }>(`/api/v1/courses/${courseId}`);
      setCourse(data.course);
      // レッスンがコース詳細に含まれている場合はそれを使用
      if (data.course.lessons) {
        const sorted = [...data.course.lessons].sort((a, b) => a.order - b.order);
        setLessons(sorted);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "講座の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch, courseId]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse]);

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
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">{course.name}</h1>
            {course.description && (
              <p className="text-muted-foreground whitespace-pre-wrap">{course.description}</p>
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
                  {lessons.map((lesson, index) => (
                    <TableRow key={lesson.id}>
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
                        {/* 完了状態は後のPhaseで実装 */}
                        <span className="text-muted-foreground text-sm">未実装</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
