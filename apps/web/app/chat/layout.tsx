"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChatSidebar } from "@/components/ui/chat-sidebar";
import { ConversationProvider } from "@/components/providers/conversation-provider";
import { ChatShellProvider, useChatShell } from "@/components/providers/chat-shell-provider";
import { useAuth } from "@/components/providers/auth-provider";

function ChatFrame({ children }: { children: React.ReactNode }) {
  const { collapsed, mobileOpen, closeMobile } = useChatShell();

  return (
    <main className={`dm-chat-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      {mobileOpen ? (
        <button className="dm-mobile-sidebar-overlay" aria-label="关闭会话导航" onClick={closeMobile} type="button" />
      ) : null}
      <ChatSidebar />
      {children}
    </main>
  );
}

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace("/login");
    }
  }, [me, loading, router]);

  if (loading || !me) {
    return (
      <main className="dm-chat-shell dm-chat-shell-loading">
        <span>加载中…</span>
      </main>
    );
  }

  return (
    <ConversationProvider>
      <ChatShellProvider>
        <ChatFrame>{children}</ChatFrame>
      </ChatShellProvider>
    </ConversationProvider>
  );
}
