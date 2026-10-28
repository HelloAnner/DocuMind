"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ProductAdminShell } from "@/components/ui/product-admin-shell";
import { useAuth } from "@/components/providers/auth-provider";
import { canAccessAdmin } from "@/lib/auth";

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    const canAccess = me && me.scope === "tenant" && canAccessAdmin(me.roles);
    if (!canAccess) {
      router.replace("/");
    }
  }, [me, loading, router]);

  if (loading || !me) return <ProductAdminShell loading />;

  return <ProductAdminShell>{children}</ProductAdminShell>;
}
