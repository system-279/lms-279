"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSuperAdminFetch } from "@/lib/super-api";

type Course = {
  id: string;
  name: string;
  status: string;
};

type Tenant = {
  id: string;
  name: string;
};

type DistributionResult = {
  tenantId: string;
  courseId: string;
  masterCourseId: string;
  status: "success" | "skipped" | "error";
  reason?: string;
  lessonsCount: number;
  videosCount: number;
  quizzesCount: number;
};

export default function DistributePage() {
  const { superFetch } = useSuperAdminFetch();
  const superFetchRef = useRef(superFetch);
  superFetchRef.current = superFetch;

  const [courses, setCourses] = useState<Course[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedCourses, setSelectedCourses] = useState<Set<string>>(
    new Set(),
  );
  const [selectedTenants, setSelectedTenants] = useState<Set<string>>(
    new Set(),
  );

  const [distributing, setDistributing] = useState(false);
  const [results, setResults] = useState<DistributionResult[] | null>(null);
  const [forceRedistribute, setForceRedistribute] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [coursesData, tenantsData] = await Promise.all([
        superFetchRef.current<{ courses: Course[] }>("/api/v2/super/master/courses"),
        superFetchRef.current<{ tenants: Tenant[] }>("/api/v2/super/tenants"),
      ]);
      setCourses(coursesData.courses);
      setTenants(tenantsData.tenants);
    } catch (e) {
      setError(e instanceof Error ? e.message : "データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Course selection
  const toggleCourse = (id: string) => {
    setSelectedCourses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllCourses = () => {
    if (selectedCourses.size === courses.length) {
      setSelectedCourses(new Set());
    } else {
      setSelectedCourses(new Set(courses.map((c) => c.id)));
    }
  };

  // Tenant selection
  const toggleTenant = (id: string) => {
    setSelectedTenants((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllTenants = () => {
    if (selectedTenants.size === tenants.length) {
      setSelectedTenants(new Set());
    } else {
      setSelectedTenants(new Set(tenants.map((t) => t.id)));
    }
  };

  const handleDistribute = async () => {
    if (selectedCourses.size === 0 || selectedTenants.size === 0) return;
    setDistributing(true);
    setError(null);
    setResults(null);
    try {
      const data = await superFetch<{ results: DistributionResult[] }>(
        "/api/v2/super/master/distribute",
        {
          method: "POST",
          body: JSON.stringify({
            courseIds: Array.from(selectedCourses),
            tenantIds: Array.from(selectedTenants),
            force: forceRedistribute,
          }),
        },
      );
      setResults(data.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "配信に失敗しました");
    } finally {
      setDistributing(false);
    }
  };

  const getCourseName = (id: string) =>
    courses.find((c) => c.id === id)?.name ?? id;

  const getTenantName = (id: string) =>
    tenants.find((t) => t.id === id)?.name ?? id;

  if (loading) {
    return <div className="text-muted-foreground">読み込み中...</div>;
  }

  if (error && !results) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">テナント配信</h1>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left: Course selection */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">マスターコース</h2>
            <Button variant="outline" size="sm" onClick={toggleAllCourses}>
              {selectedCourses.size === courses.length
                ? "全解除"
                : "全選択"}
            </Button>
          </div>
          {courses.length === 0 ? (
            <div className="rounded-md border p-8 text-center text-muted-foreground">
              マスターコースがありません
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {courses.map((course) => (
                <label
                  key={course.id}
                  className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedCourses.has(course.id)}
                    onCheckedChange={() => toggleCourse(course.id)}
                  />
                  <span className="flex-1 text-sm">{course.name}</span>
                  <Badge variant="secondary" className="text-xs">
                    {course.status === "published"
                      ? "公開中"
                      : course.status === "archived"
                        ? "アーカイブ"
                        : "下書き"}
                  </Badge>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {selectedCourses.size} 件選択中
          </p>
        </div>

        {/* Right: Tenant selection */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">テナント</h2>
            <Button variant="outline" size="sm" onClick={toggleAllTenants}>
              {selectedTenants.size === tenants.length
                ? "全解除"
                : "全選択"}
            </Button>
          </div>
          {tenants.length === 0 ? (
            <div className="rounded-md border p-8 text-center text-muted-foreground">
              テナントがありません
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {tenants.map((tenant) => (
                <label
                  key={tenant.id}
                  className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedTenants.has(tenant.id)}
                    onCheckedChange={() => toggleTenant(tenant.id)}
                  />
                  <span className="flex-1 text-sm">{tenant.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {tenant.id}
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {selectedTenants.size} 件選択中
          </p>
        </div>
      </div>

      {/* Options */}
      <div className="flex items-center justify-center gap-3 pt-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={forceRedistribute}
            onCheckedChange={(checked) => setForceRedistribute(!!checked)}
          />
          <span className="text-sm">再配信（配信済みコースを上書き更新）</span>
        </label>
      </div>

      {/* Distribute button */}
      <div className="flex justify-center pt-4">
        <Button
          size="lg"
          onClick={handleDistribute}
          disabled={
            distributing ||
            selectedCourses.size === 0 ||
            selectedTenants.size === 0
          }
        >
          {distributing
            ? "配信中..."
            : `配信実行（${selectedCourses.size} コース → ${selectedTenants.size} テナント）`}
        </Button>
      </div>

      {/* Results */}
      {results && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">配信結果</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>テナント</TableHead>
                <TableHead>コース</TableHead>
                <TableHead>ステータス</TableHead>
                <TableHead>レッスン</TableHead>
                <TableHead>動画</TableHead>
                <TableHead>テスト</TableHead>
                <TableHead>備考</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow key={`${r.tenantId}-${r.masterCourseId}`}>
                  <TableCell className="text-sm">
                    {getTenantName(r.tenantId)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {getCourseName(r.masterCourseId)}
                  </TableCell>
                  <TableCell>
                    {r.status === "success" && (
                      <Badge className="bg-green-100 text-green-800 border-green-200">
                        成功
                      </Badge>
                    )}
                    {r.status === "skipped" && (
                      <Badge variant="secondary">スキップ</Badge>
                    )}
                    {r.status === "error" && (
                      <Badge className="bg-red-100 text-red-800 border-red-200">
                        エラー
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{r.lessonsCount}</TableCell>
                  <TableCell className="text-sm">{r.videosCount}</TableCell>
                  <TableCell className="text-sm">{r.quizzesCount}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.reason ?? "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-sm text-muted-foreground">
            成功: {results.filter((r) => r.status === "success").length} / スキップ:{" "}
            {results.filter((r) => r.status === "skipped").length} / エラー:{" "}
            {results.filter((r) => r.status === "error").length}
          </p>
        </div>
      )}
    </div>
  );
}
