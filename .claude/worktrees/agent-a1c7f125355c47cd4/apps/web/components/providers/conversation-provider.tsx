"use client";

import { createContext, useContext } from "react";
import { useConversationManager } from "@/hooks/use-conversation-manager";

type ConversationContextValue = ReturnType<typeof useConversationManager>;

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const value = useConversationManager();
  return (
    <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>
  );
}

export function useConversation() {
  const ctx = useContext(ConversationContext);
  if (!ctx) {
    throw new Error("useConversation must be used within ConversationProvider");
  }
  return ctx;
}
