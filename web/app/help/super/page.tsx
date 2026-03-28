import type { Metadata } from "next";
import { RoleHelpPage } from "../_components/RoleHelpPage";
import { superSections } from "../_data/super-sections";

export const metadata: Metadata = {
  title: "スーパー管理者ヘルプ - LMS 279",
  description: "ス���パー管理者向けの使い��ガイド",
};

export default function SuperHelpPage() {
  return (
    <RoleHelpPage roleName="スーパー管理者" sections={superSections} />
  );
}
