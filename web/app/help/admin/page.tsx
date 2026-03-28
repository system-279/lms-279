import type { Metadata } from "next";
import { RoleHelpPage } from "../_components/RoleHelpPage";
import { adminSections } from "../_data/admin-sections";

export const metadata: Metadata = {
  title: "管理者ヘルプ - LMS 279",
  description: "テナント管理者向けの使い方ガイド",
};

export default function AdminHelpPage() {
  return <RoleHelpPage roleName="管理者" sections={adminSections} />;
}
