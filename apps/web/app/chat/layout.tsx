"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChatSidebar } from "@/components/ui/chat-sidebar";
import { ConversationProvider } from "@/components/providers/conversation-provider";
import { useAuth } from "@/components/providers/auth-provider";

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
      <main className="dm-chat-shell">
        <div style={{ display: "grid", flex: 1, placeItems: "center", color: "var(--text-muted)" }}>
          <span>加载中…</span>
        </div>
      </main>
    );
  }

  return (
    <ConversationProvider>
      <main className="dm-chat-shell">
        <ChatSidebar />
        {children}
      </main>
    </ConversationProvider>
  );
}
