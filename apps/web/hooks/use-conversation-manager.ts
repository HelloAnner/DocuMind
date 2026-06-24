"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelMessage,
  createConversation,
  deleteConversation,
  getMessages,
  listConversations,
  listKnowledgeBases,
  retryMessageStreamUrl,
  sendMessageStreamUrl,
  submitFeedback,
  type KnowledgeBase,
} from "@/lib/api";
import { streamSse } from "@/lib/sse";
import type {
  Citation,
  Conversation,
  FeedbackReason,
  Message,
  MessageStatus,
  Rating,
  RetryMessageRequest,
  SendMessageRequest,
} from "@/lib/types";

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
  const router = useRouter();
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
  const [availableKbs, setAvailableKbs] = useState<KnowledgeBase[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const pendingRef = useRef<{ userTempId: string; assistantTempId: string } | null>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const skipLoadRef = useRef<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await listConversations();
      setConversations(res.items);
    } catch (e) {
      console.error("failed to load conversations", e);
    }
  }, []);

  const loadKnowledgeBases = useCallback(async () => {
    try {
      const kbs = await listKnowledgeBases();
      setAvailableKbs(kbs);
    } catch (e) {
      console.error("failed to load knowledge bases", e);
    }
  }, []);

  useEffect(() => {
    loadConversations();
    loadKnowledgeBases();
    try {
      const raw = localStorage.getItem("documind:favorite-conversations");
      if (raw) {
        const ids = JSON.parse(raw) as string[];
        setFavorites(new Set(ids));
      }
    } catch {
      // ignore
    }
  }, [loadConversations, loadKnowledgeBases]);

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
    if (!currentId) {
      setMessages([]);
      return;
    }
    if (skipLoadRef.current === currentId) {
      skipLoadRef.current = null;
      return;
    }
    loadMessages(currentId);
  }, [currentId, loadMessages]);

  const allKbIds = useMemo(() => availableKbs.map((kb) => kb.id), [availableKbs]);

  const createAndSelect = useCallback(
    async (title?: string) => {
      try {
        const conv = await createConversation({
          kb_ids: allKbIds,
          title,
        });
        setConversations((prev) => [conv, ...prev]);
        skipLoadRef.current = conv.conversation_id;
        setCurrentId(conv.conversation_id);
        router.push(`/chat?c=${encodeURIComponent(conv.conversation_id)}`);
        return conv.conversation_id;
      } catch (e) {
        console.error("failed to create conversation", e);
        return null;
      }
    },
    [allKbIds, router]
  );

  const updateMessage = useCallback((messageId: string, patch: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((m) => (m.message_id === messageId ? { ...m, ...patch } : m))
    );
  }, []);

  const processStream = useCallback(
    async (
      conversationId: string,
      userContent: string,
      req: SendMessageRequest | RetryMessageRequest,
      url: string,
      controller: AbortController,
      isRetry = false
    ) => {
      const userTempId = `tmp-user-${Date.now()}`;
      const assistantTempId = `tmp-assistant-${Date.now()}`;
      pendingRef.current = { userTempId, assistantTempId };

      if (!isRetry) {
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
      } else {
        setMessages((prev) => [
          ...prev,
          {
            message_id: assistantTempId,
            role: "assistant",
            content: "",
            status: "answering",
            citations: [],
            created_at: new Date().toISOString(),
          },
        ]);
      }

      setStages([
        { label: "查询改写", done: false, running: true },
        { label: "混合检索", done: false },
        { label: "重排序", done: false },
        { label: "生成答案", done: false },
      ]);

      let assistantId = assistantTempId;
      try {
        for await (const sse of streamSse(url, req, controller.signal)) {
          if (controller.signal.aborted) {
            break;
          }
          if (sse.event === "message.created") {
            const data = sse.data as {
              user_message_id: string;
              assistant_message_id: string;
            };
            if (!isRetry) {
              updateMessage(userTempId, { message_id: data.user_message_id });
            }
            updateMessage(assistantTempId, { message_id: data.assistant_message_id });
            assistantId = data.assistant_message_id;
            abortControllersRef.current.set(assistantId, controller);
            setStreamingId(assistantId);
          } else if (sse.event === "status.updated") {
            const data = sse.data as { message_id: string; status: string };
            if (data.message_id !== assistantId && data.message_id !== assistantTempId) continue;
            if (data.status === "rewriting") {
              setStages([
                { label: "查询改写", done: false, running: true },
                { label: "混合检索", done: false },
                { label: "重排序", done: false },
                { label: "生成答案", done: false },
              ]);
            } else if (data.status === "retrieving") {
              setStages([
                { label: "查询改写", done: true },
                { label: "混合检索", done: false, running: true },
                { label: "重排序", done: false },
                { label: "生成答案", done: false },
              ]);
            } else if (data.status === "reranking") {
              setStages([
                { label: "查询改写", done: true },
                { label: "混合检索", done: true },
                { label: "重排序", done: false, running: true },
                { label: "生成答案", done: false },
              ]);
            } else if (data.status === "generating") {
              setStages([
                { label: "查询改写", done: true },
                { label: "混合检索", done: true },
                { label: "重排序", done: true },
                { label: "生成答案", done: false, running: true },
              ]);
            }
          } else if (sse.event === "rewrite.completed") {
            setStages((s) =>
              s.map((stage) =>
                stage.label === "查询改写" ? { ...stage, done: true, running: false } : stage
              )
            );
          } else if (sse.event === "retrieval.completed") {
            setStages((s) =>
              s.map((stage) =>
                stage.label === "混合检索" ? { ...stage, done: true, running: false } : stage
              )
            );
          } else if (sse.event === "rerank.completed") {
            setStages((s) =>
              s.map((stage) =>
                stage.label === "重排序" ? { ...stage, done: true, running: false } : stage
              )
            );
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
            setStages((s) => s.map((stage) => ({ ...stage, running: false })));
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          updateMessage(assistantId, { status: "cancelled" as MessageStatus });
        } else {
          console.error("stream error", e);
          updateMessage(assistantId, {
            status: "failed",
            content: "连接中断，请稍后重试。",
          });
        }
      } finally {
        abortControllersRef.current.delete(assistantId);
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
        kb_ids: allKbIds,
        client_request_id: `req-${Date.now()}`,
        stream: true,
      };
      const controller = new AbortController();
      await processStream(
        conversationId,
        content,
        req,
        sendMessageStreamUrl(conversationId),
        controller,
        false
      );
    },
    [currentId, createAndSelect, processStream, allKbIds]
  );

  const retryMessage = useCallback(
    async (messageId: string) => {
      if (!currentId) return;
      const controller = new AbortController();
      const url = retryMessageStreamUrl(currentId, messageId);
      const req: RetryMessageRequest = { stream: true };
      await processStream(currentId, "", req, url, controller, true);
    },
    [currentId, processStream]
  );

  const doCancelMessage = useCallback(
    async (messageId: string) => {
      if (!currentId) return;
      const controller = abortControllersRef.current.get(messageId);
      if (controller) {
        controller.abort();
      }
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

  const isFavorite = useCallback(
    (conversationId: string) => favorites.has(conversationId),
    [favorites]
  );

  const toggleFavorite = useCallback((conversationId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      try {
        localStorage.setItem("documind:favorite-conversations", JSON.stringify(Array.from(next)));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const doDeleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        await deleteConversation(conversationId);
        setConversations((prev) => prev.filter((c) => c.conversation_id !== conversationId));
        if (currentId === conversationId) {
          setCurrentId(null);
        }
        setFavorites((prev) => {
          const next = new Set(prev);
          next.delete(conversationId);
          try {
            localStorage.setItem(
              "documind:favorite-conversations",
              JSON.stringify(Array.from(next))
            );
          } catch {
            // ignore
          }
          return next;
        });
      } catch (e) {
        console.error("delete conversation failed", e);
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
    availableKbs,
    createAndSelect,
    sendMessage,
    retryMessage,
    cancelMessage: doCancelMessage,
    submitFeedback: doSubmitFeedback,
    refreshConversations: loadConversations,
    isFavorite,
    toggleFavorite,
    deleteConversation: doDeleteConversation,
  };
}
