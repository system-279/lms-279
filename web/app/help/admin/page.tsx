"use client";

import { RoleHelpPage } from "../_components/RoleHelpPage";
import { HelpAccessGuard } from "../_components/HelpAccessGuard";
import { adminSections } from "../_data/admin-sections";

export default function AdminHelpPage() {
  return (
    <HelpAccessGuard requiredLevel="admin">
      <RoleHelpPage roleName="管理者" sections={adminSections} />
    </HelpAccessGuard>
  );
}
