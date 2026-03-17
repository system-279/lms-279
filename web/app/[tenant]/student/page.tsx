"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTenant } from "@/lib/tenant-context";

/**
 * テナント対応受講者トップページ
 * 講座一覧にリダイレクト
 */
export default function TenantStudentPage() {
  const router = useRouter();
  const { tenantId } = useTenant();

  useEffect(() => {
    router.replace(`/${tenantId}/student/courses`);
  }, [router, tenantId]);

  return (
    <div className="text-muted-foreground">
      リダイレクト中...
    </div>
  );
}
