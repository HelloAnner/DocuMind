"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { SkillManagement } from "@/components/views/admin-skills";

export default function AdminSkillsPage() {
  const { me } = useAuth();
  const canEdit = !!me?.roles.some((role) => ["super_admin", "tenant_owner", "tenant_admin", "enterprise_admin"].includes(role));
  return <SkillManagement canEdit={canEdit} />;
}
