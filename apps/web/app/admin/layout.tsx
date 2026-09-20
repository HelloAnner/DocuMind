"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ConversationProvider } from "@/components/providers/conversation-provider";
import { ChatShellProvider, useChatShell } from "@/components/providers/chat-shell-provider";
import { useAuth } from "@/components/providers/auth-provider";
import { ChatSidebar } from "@/components/ui/chat-sidebar";
import { ProductAdminShell } from "@/components/ui/product-admin-shell";
import { canAccessAdmin, isSuperAdminRole } from "@/lib/auth";

function KnowledgeWorkspace({ children }: { children: React.ReactNode }) {
  const { collapsed, mobileOpen, closeMobile } = useChatShell();
  return (
    <main className={`dm-chat-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      {mobileOpen ? <button className="dm-mobile-sidebar-overlay" aria-label="关闭导航" onClick={closeMobile} type="button" /> : null}
      <ChatSidebar />
      <section className="dm-workspace dm-chat-admin-workspace">{children}</section>
    </main>
  );
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    const canAccess = me && (
      (me.scope === "tenant" && canAccessAdmin(me.roles))
      || (me.scope === "platform" && isSuperAdminRole(me.roles))
    );
    if (!canAccess) {
      router.replace("/");
    }
  }, [me, loading, router]);

  if (loading || !me) return <ProductAdminShell loading />;

  const usesKnowledgeWorkspace = me.scope === "tenant" && [
    "/admin/knowledge",
    "/admin/documents",
    "/admin/document-jobs",
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (usesKnowledgeWorkspace) {
    return (
      <ConversationProvider>
        <ChatShellProvider>
          <KnowledgeWorkspace>{children}</KnowledgeWorkspace>
        </ChatShellProvider>
      </ConversationProvider>
    );
  }

  return <ProductAdminShell>{children}</ProductAdminShell>;
}
