"use client";

import { useParams } from "next/navigation";
import { useEffect } from "react";
import { ChatWorkspace } from "@/components/views/chat-workspace";
import { useConversation } from "@/components/providers/conversation-provider";

export function ChatDetailClient() {
  const params = useParams();
  const { currentId, setCurrentId } = useConversation();
  const conversationId = params.id as string;

  useEffect(() => {
    if (conversationId && conversationId !== currentId) {
      setCurrentId(conversationId);
    }
  }, [conversationId, currentId, setCurrentId]);

  return <ChatWorkspace />;
}
