"use client";

import { RoleHelpPage } from "../_components/RoleHelpPage";
import { HelpAccessGuard } from "../_components/HelpAccessGuard";
import { superSections } from "../_data/super-sections";

export default function SuperHelpPage() {
  return (
    <HelpAccessGuard requiredLevel="super">
      <RoleHelpPage
        roleName="スーパー管理者"
        sections={superSections}
        appLink={{ href: "/super/master/courses", label: "スーパー管理画面へ" }}
      />
    </HelpAccessGuard>
  );
}
