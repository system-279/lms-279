import type { Metadata } from "next";
import { RoleHelpPage } from "../_components/RoleHelpPage";
import { superSections } from "../_data/super-sections";

export const metadata: Metadata = {
  title: "スーパー管理者ヘルプ - LMS 279",
  description: "スーパー管理者向けの使い方ガイド",
};

export default function SuperHelpPage() {
  return (
    <RoleHelpPage
      roleName="スーパー管理者"
      sections={superSections}
      appLink={{ href: "/super/master/courses", label: "スーパー管理画面へ" }}
    />
  );
}
