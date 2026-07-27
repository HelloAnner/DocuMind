"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ProductAdminShell } from "@/components/ui/product-admin-shell";
import { useAuth } from "@/components/providers/auth-provider";

export default function SystemLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!me || !me.roles.includes("super_admin")) {
      router.replace("/");
    }
  }, [me, loading, router]);

  if (loading || !me) return <ProductAdminShell loading />;

  return <ProductAdminShell>{children}</ProductAdminShell>;
}
