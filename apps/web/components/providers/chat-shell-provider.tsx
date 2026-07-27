"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface ChatShellContextValue {
  collapsed: boolean;
  mobileOpen: boolean;
  closeMobile: () => void;
  openMobile: () => void;
  toggleCollapsed: () => void;
}

const COLLAPSED_KEY = "documind:chat-sidebar-collapsed";
const ChatShellContext = createContext<ChatShellContextValue | null>(null);

export function ChatShellProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "true");
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const value = useMemo(
    () => ({ collapsed, mobileOpen, closeMobile, openMobile, toggleCollapsed }),
    [closeMobile, collapsed, mobileOpen, openMobile, toggleCollapsed]
  );

  return <ChatShellContext.Provider value={value}>{children}</ChatShellContext.Provider>;
}

export function useChatShell() {
  const context = useContext(ChatShellContext);
  if (!context) throw new Error("useChatShell must be used within ChatShellProvider");
  return context;
}
