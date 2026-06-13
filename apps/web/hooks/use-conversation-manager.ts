"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelMessage,
  createConversation,
  getMessages,
  listConversations,
  sendMessageStreamUrl,
  submitFeedback,
} from "@/lib/api";
import { streamSse } from "@/lib/sse";
import type {
  Citation,
  Conversation,
  FeedbackReason,
  Message,
  MessageStatus,
  Rating,
  SendMessageRequest,
} from "@/lib/types";

const DEFAULT_KB_ID = "00000000-0000-0000-0000-000000000003";

export type PipelineStage = {
  label: string;
  done: boolean;
  running?: boolean;
};

export type FeedbackState = {
  messageId: string;
  rating: Rating;
  reason?: FeedbackReason;
  comment?: string;
  correction?: string;
};

export function useConversationManager() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [stages, setStages] = useState<PipelineStage[]>([
    { label: "查询改写", done: false },
    { label: "混合检索", done: false },
    { label: "重排序", done: false },
    { label: "生成答案", done: false },
  ]);
  const [rightOpen, setRightOpen] = useState(false);
  const pendingRef = useRef<{ userTempId: string; assistantTempId: string } | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await listConversations();
      setConversations(res.items);
    } catch (e) {
      console.error("failed to load conversations", e);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      setLoading(true);
      try {
        const res = await getMessages(conversationId);
        setMessages(res.messages);
      } catch (e) {
        console.error("failed to load messages", e);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (currentId) {
      loadMessages(currentId);
    } else {
      setMessages([]);
    }
  }, [currentId, loadMessages]);

  const createAndSelect = useCallback(async (title?: string) => {
    try {
      const conv = await createConversation({
        kb_ids: [DEFAULT_KB_ID],
        title,
      });
      setConversations((prev) => [conv, ...prev]);
      setCurrentId(conv.conversation_id);
      return conv.conversation_id;
    } catch (e) {
      console.error("failed to create conversation", e);
      return null;
    }
  }, []);

  const updateMessage = useCallback((messageId: string, patch: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((m) => (m.message_id === messageId ? { ...m, ...patch } : m))
    );
  }, []);

  const processStream = useCallback(
    async (conversationId: string, userContent: string, req: SendMessageRequest) => {
      const userTempId = `tmp-user-${Date.now()}`;
      const assistantTempId = `tmp-assistant-${Date.now()}`;
      pendingRef.current = { userTempId, assistantTempId };

      setMessages((prev) => [
        ...prev,
        {
          message_id: userTempId,
          role: "user",
          content: userContent,
          status: "completed",
          citations: [],
          created_at: new Date().toISOString(),
        },
        {
          message_id: assistantTempId,
          role: "assistant",
          content: "",
          status: "answering",
          citations: [],
          created_at: new Date().toISOString(),
        },
      ]);

      setStages([
        { label: "查询改写", done: false, running: true },
        { label: "混合检索", done: false, running: true },
        { label: "重排序", done: false, running: true },
        { label: "生成答案", done: false, running: true },
      ]);

      let assistantId = assistantTempId;
      try {
        for await (const sse of streamSse(sendMessageStreamUrl(conversationId), req)) {
          if (sse.event === "message.created") {
            const data = sse.data as {
              user_message_id: string;
              assistant_message_id: string;
            };
            updateMessage(userTempId, { message_id: data.user_message_id });
            updateMessage(assistantTempId, { message_id: data.assistant_message_id });
            assistantId = data.assistant_message_id;
            setStreamingId(assistantId);
            setStages([
              { label: "查询改写", done: true },
              { label: "混合检索", done: true },
              { label: "重排序", done: true },
              { label: "生成答案", done: false, running: true },
            ]);
          } else if (sse.event === "answer.delta") {
            const data = sse.data as { message_id: string; text: string };
            setMessages((prev) =>
              prev.map((m) =>
                m.message_id === data.message_id || m.message_id === assistantTempId
                  ? { ...m, content: m.content + data.text }
                  : m
              )
            );
          } else if (sse.event === "citation.delta") {
            const data = sse.data as { message_id: string; citation: Citation };
            setMessages((prev) =>
              prev.map((m) =>
                m.message_id === data.message_id || m.message_id === assistantTempId
                  ? { ...m, citations: [...m.citations, data.citation] }
                  : m
              )
            );
          } else if (sse.event === "answer.completed") {
            const data = sse.data as {
              message_id: string;
              confidence: "high" | "medium" | "low";
            };
            updateMessage(data.message_id, {
              status: "completed",
              confidence: data.confidence,
            });
            setStages((s) =>
              s.map((stage) =>
                stage.label === "生成答案" ? { ...stage, done: true, running: false } : stage
              )
            );
          } else if (sse.event === "answer.failed") {
            const data = sse.data as { message_id: string; code: string; message: string };
            updateMessage(data.message_id, {
              status: "failed",
              content: data.message,
            });
          }
        }
      } catch (e) {
        console.error("stream error", e);
        updateMessage(assistantId, {
          status: "failed",
          content: "连接中断，请稍后重试。",
        });
      } finally {
        setStreamingId(null);
        pendingRef.current = null;
        loadConversations();
      }
    },
    [updateMessage, loadConversations]
  );

  const sendMessage = useCallback(
    async (content: string) => {
      let conversationId = currentId;
      if (!conversationId) {
        const created = await createAndSelect();
        if (!created) return;
        conversationId = created;
      }

      const req: SendMessageRequest = {
        content,
        client_request_id: `req-${Date.now()}`,
        stream: true,
      };

      await processStream(conversationId, content, req);
    },
    [currentId, createAndSelect, processStream]
  );

  const retryMessage = useCallback(
    async (messageId: string) => {
      if (!currentId) return;
      // Find the user message that this assistant message responded to.
      const target = messages.find((m) => m.message_id === messageId);
      if (!target || target.role !== "assistant" || !target.parent_message_id) return;
      const parent = messages.find((m) => m.message_id === target.parent_message_id);
      if (!parent) return;

      const req: SendMessageRequest = {
        content: parent.content,
        client_request_id: `req-${Date.now()}`,
        stream: true,
      };
      await processStream(currentId, parent.content, req);
    },
    [currentId, messages, processStream]
  );

  const doCancelMessage = useCallback(
    async (messageId: string) => {
      if (!currentId) return;
      try {
        const res = await cancelMessage(currentId, messageId);
        updateMessage(res.message_id, { status: "cancelled" as MessageStatus });
      } catch (e) {
        console.error("cancel failed", e);
      }
    },
    [currentId, updateMessage]
  );

  const doSubmitFeedback = useCallback(
    async (
      messageId: string,
      rating: Rating,
      reason?: FeedbackReason,
      comment?: string,
      correction?: string
    ) => {
      if (!currentId) return;
      try {
        await submitFeedback(currentId, messageId, { rating, reason, comment, correction });
      } catch (e) {
        console.error("feedback failed", e);
      }
    },
    [currentId]
  );

  return {
    conversations,
    currentId,
    messages,
    loading,
    streamingId,
    stages,
    rightOpen,
    setRightOpen,
    setCurrentId,
    createAndSelect,
    sendMessage,
    retryMessage,
    cancelMessage: doCancelMessage,
    submitFeedback: doSubmitFeedback,
    refreshConversations: loadConversations,
  };
}
