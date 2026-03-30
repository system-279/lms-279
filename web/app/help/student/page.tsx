import type { Metadata } from "next";
import { RoleHelpPage } from "../_components/RoleHelpPage";
import { studentSections } from "../_data/student-sections";

export const metadata: Metadata = {
  title: "受講者ヘルプ - 介護DX college２７９Classroom",
  description: "受講者向けの使い方ガイド",
};

export default function StudentHelpPage() {
  return <RoleHelpPage roleName="受講者" sections={studentSections} />;
}
