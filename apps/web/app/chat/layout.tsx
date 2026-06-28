"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatSidebar } from "@/components/ui/chat-sidebar";
import { ConversationProvider } from "@/components/providers/conversation-provider";
import { useAuth } from "@/components/providers/auth-provider";

const SIDEBAR_WIDTH_KEY = "documind:chat-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 244;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;

function clampWidth(width: number) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (!raw) return DEFAULT_SIDEBAR_WIDTH;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_SIDEBAR_WIDTH;
  return clampWidth(parsed);
}

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { me, loading } = useAuth();
  const [sidebarWidth, setSidebarWidth] = useState<number>(DEFAULT_SIDEBAR_WIDTH);

  useEffect(() => {
    setSidebarWidth(readStoredWidth());
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace("/login");
    }
  }, [me, loading, router]);

  const handleResize = (width: number) => {
    const clamped = clampWidth(width);
    setSidebarWidth(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
    }
  };

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
      <main
        className="dm-chat-shell"
        style={{ ["--dm-chat-sidebar-width-user" as string]: `${sidebarWidth}px` }}
      >
        <ChatSidebar width={sidebarWidth} onResize={handleResize} />
        {children}
      </main>
    </ConversationProvider>
  );
}
