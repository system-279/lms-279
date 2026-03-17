"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useTenant } from "@/lib/tenant-context";

type CourseProgress = {
  completedLessonCount: number;
  totalLessonCount: number;
  progressRatio: number;
  courseCompleted: boolean;
};

type Course = {
  id: string;
  name: string;
  description: string;
  lessonCount?: number;
  lessonOrder?: string[];
  progress?: CourseProgress;
};

export default function StudentCoursesPage() {
  const { tenantId } = useTenant();
  const { authFetch } = useAuthenticatedFetch();

  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCourses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<{ courses: Course[] }>("/api/v1/courses");
      setCourses(data.courses);
    } catch (e) {
      setError(e instanceof Error ? e.message : "講座の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">講座一覧</h1>
        <p className="text-sm text-muted-foreground mt-1">
          受講可能な講座の一覧です。
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : courses.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          現在受講可能な講座がありません
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => {
            const progress = course.progress ?? null;
            const completedCount = progress?.completedLessonCount ?? 0;
            const totalCount = progress?.totalLessonCount ?? course.lessonCount ?? course.lessonOrder?.length ?? 0;
            const progressPercent = progress
              ? Math.round(progress.progressRatio * 100)
              : totalCount > 0
              ? Math.round((completedCount / totalCount) * 100)
              : 0;
            const isCourseCompleted = progress?.courseCompleted ?? false;

            return (
              <Link
                key={course.id}
                href={`/${tenantId}/student/courses/${course.id}`}
                className="group"
              >
                <Card className="h-full transition-shadow hover:shadow-md group-hover:border-primary/50">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-lg">{course.name}</CardTitle>
                      {isCourseCompleted && (
                        <Badge className="flex-shrink-0 bg-green-600 hover:bg-green-600 text-white">
                          完了
                        </Badge>
                      )}
                    </div>
                    {course.description && (
                      <CardDescription className="line-clamp-3">
                        {course.description}
                      </CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      レッスン数: {course.lessonCount ?? course.lessonOrder?.length ?? 0}
                    </p>
                    {progress != null ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>
                            {completedCount}/{totalCount} レッスン完了
                          </span>
                          <span>{progressPercent}%</span>
                        </div>
                        <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-2 rounded-full transition-all duration-500 ${
                              isCourseCompleted ? "bg-green-500" : "bg-primary"
                            }`}
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
