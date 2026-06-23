"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ChatWorkspace } from "@/components/views/chat-workspace";
import { useConversation } from "@/components/providers/conversation-provider";

export function ChatPageClient() {
  const searchParams = useSearchParams();
  const { setCurrentId } = useConversation();
  const conversationId = searchParams.get("c");

  useEffect(() => {
    setCurrentId(conversationId || null);
  }, [conversationId, setCurrentId]);

  return <ChatWorkspace />;
}
