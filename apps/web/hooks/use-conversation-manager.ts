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
  RuntimeToolCall,
  RuntimeEventEnvelope,
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

function isRuntimeEvent(data: unknown): data is RuntimeEventEnvelope {
  if (!data || typeof data !== "object") return false;
  const event = data as Partial<RuntimeEventEnvelope>;
  return event.schema_version === "moss.execution.event.v1" && typeof event.event_type === "string";
}

function stageLabelFromRuntime(event: RuntimeEventEnvelope): string | null {
  const display = event.payload.display;
  if (display && typeof display === "object") {
    const data = (display as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const label = (data as { label?: unknown }).label;
      if (typeof label === "string") return label;
    }
  }

  const displayName = event.payload.display_name;
  if (typeof displayName === "string") return displayName;

  const name = event.step?.name ?? event.payload.name;
  if (name === "query_rewrite") return "查询改写";
  if (name === "hybrid_retrieval") return "混合检索";
  if (name === "rerank") return "重排序";
  if (name === "answer_generation") return "生成答案";
  return null;
}

function confidenceFromRuntime(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function firstRuntimeString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function runtimeToolId(event: RuntimeEventEnvelope) {
  return firstRuntimeString(event.payload.tool_call_id, event.step?.step_id, event.step?.name);
}

function normalizeToolStatus(value: unknown): RuntimeToolCall["status"] {
  if (value === "failed" || value === "cancelled" || value === "succeeded") return value;
  return "running";
}

function runtimeToolName(event: RuntimeEventEnvelope, fallback: string) {
  return firstRuntimeString(event.payload.name, event.step?.name, event.payload.display_name, fallback);
}

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
      const updateAssistantInStream = (patch: Partial<Message>) => {
        const messageId = assistantId;
        setMessages((prev) =>
          prev.map((m) =>
            m.message_id === messageId || m.message_id === assistantTempId ? { ...m, ...patch } : m
          )
        );
      };
      const updateToolCallInStream = (
        toolId: string,
        recipe: (tool?: RuntimeToolCall) => RuntimeToolCall
      ) => {
        const messageId = assistantId;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.message_id !== messageId && m.message_id !== assistantTempId) return m;
            const tools = m.tool_calls ?? [];
            const exists = tools.some((tool) => tool.id === toolId);
            const nextTools = exists
              ? tools.map((tool) => (tool.id === toolId ? recipe(tool) : tool))
              : [...tools, recipe(undefined)];
            return { ...m, tool_calls: nextTools };
          })
        );
      };
      try {
        for await (const sse of streamSse(url, req, controller.signal)) {
          if (controller.signal.aborted) {
            break;
          }
          const runtime = isRuntimeEvent(sse.data) ? sse.data : null;
          if (runtime) {
            if (runtime.event_type === "execution.started") {
              const data = runtime.payload as {
                user_message_id?: string;
                assistant_message_id?: string;
              };
              if (!isRetry && data.user_message_id) {
                updateMessage(userTempId, { message_id: data.user_message_id });
              }
              const runtimeAssistantId = data.assistant_message_id ?? runtime.response_message_id;
              updateMessage(assistantTempId, { message_id: runtimeAssistantId });
              assistantId = runtimeAssistantId;
              abortControllersRef.current.set(assistantId, controller);
              setStreamingId(assistantId);
              continue;
            }

            if (runtime.event_type === "thinking.delta") {
              const delta = runtime.payload.delta;
              if (typeof delta === "string") {
                const messageId = assistantId;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.message_id === messageId || m.message_id === assistantTempId
                      ? { ...m, thinking: `${m.thinking ?? ""}${delta}` }
                      : m
                  )
                );
              }
              continue;
            }

            if (runtime.event_type === "response.replace") {
              const content = runtime.payload.content;
              if (typeof content === "string") {
                updateAssistantInStream({ content });
              }
              continue;
            }

            if (runtime.event_type === "tool.call.preview") {
              const toolId = runtimeToolId(runtime);
              if (!toolId) continue;
              updateToolCallInStream(toolId, (tool) => ({
                id: toolId,
                name: runtimeToolName(runtime, tool?.name ?? toolId),
                arguments_preview: firstRuntimeString(
                  runtime.payload.arguments_preview,
                  tool?.arguments_preview
                ),
                status: "running",
                started_at: tool?.started_at ?? runtime.occurred_at,
                display: runtime.payload.display ?? tool?.display,
              }));
              continue;
            }

            if (runtime.event_type === "tool.call.started") {
              const label = stageLabelFromRuntime(runtime);
              if (label) {
                setStages((prev) =>
                  prev.map((stage) => ({
                    ...stage,
                    running: stage.label === label,
                    done: stage.label === label ? false : stage.done,
                  }))
                );
              }
              const toolId = runtimeToolId(runtime);
              if (toolId) {
                updateToolCallInStream(toolId, (tool) => ({
                  id: toolId,
                  name: runtimeToolName(runtime, tool?.name ?? toolId),
                  arguments: runtime.payload.arguments ?? tool?.arguments,
                  arguments_preview: tool?.arguments_preview,
                  status: "running",
                  started_at: tool?.started_at ?? runtime.occurred_at,
                  display: runtime.payload.display ?? tool?.display,
                }));
              }
              continue;
            }

            if (runtime.event_type === "tool.call.update") {
              const toolId = runtimeToolId(runtime);
              if (!toolId) continue;
              const progress = runtime.payload.progress;
              const message = runtime.payload.message;
              updateToolCallInStream(toolId, (tool) => ({
                id: toolId,
                name: runtimeToolName(runtime, tool?.name ?? toolId),
                arguments: tool?.arguments,
                arguments_preview: tool?.arguments_preview,
                status: tool?.status ?? "running",
                progress: typeof progress === "number" ? progress : tool?.progress,
                message: typeof message === "string" ? message : tool?.message,
                started_at: tool?.started_at,
                display: runtime.payload.display ?? tool?.display,
              }));
              continue;
            }

            if (runtime.event_type === "tool.call.result") {
              const label = stageLabelFromRuntime(runtime);
              if (label) {
                setStages((prev) =>
                  prev.map((stage) =>
                    stage.label === label ? { ...stage, done: true, running: false } : stage
                  )
                );
              }
              const toolId = runtimeToolId(runtime);
              if (toolId) {
                updateToolCallInStream(toolId, (tool) => ({
                  id: toolId,
                  name: runtimeToolName(runtime, tool?.name ?? toolId),
                  arguments: runtime.payload.arguments ?? tool?.arguments,
                  arguments_preview: tool?.arguments_preview,
                  status: normalizeToolStatus(runtime.payload.status),
                  result: typeof runtime.payload.result === "string"
                    ? runtime.payload.result
                    : tool?.result,
                  progress: typeof runtime.payload.progress === "number"
                    ? runtime.payload.progress
                    : tool?.progress,
                  message: typeof runtime.payload.message === "string"
                    ? runtime.payload.message
                    : tool?.message,
                  display: runtime.payload.display ?? tool?.display,
                  started_at: tool?.started_at,
                  completed_at: runtime.occurred_at,
                  duration_ms: typeof runtime.payload.duration_ms === "number"
                    ? runtime.payload.duration_ms
                    : tool?.duration_ms,
                }));
              }
              continue;
            }

            if (runtime.event_type === "response.delta") {
              const delta = runtime.payload.delta;
              if (typeof delta !== "string") continue;
              const messageId = runtime.response_message_id;
              setMessages((prev) =>
                prev.map((m) =>
                  m.message_id === messageId || m.message_id === assistantTempId
                    ? { ...m, content: m.content + delta }
                    : m
                )
              );
              continue;
            }

            if (runtime.event_type === "sources.reported") {
              const sources = runtime.payload.sources;
              if (!Array.isArray(sources)) continue;
              const citations = sources
                .map((source) =>
                  source && typeof source === "object"
                    ? (source as { documind_citation?: Citation }).documind_citation
                    : undefined
                )
                .filter((citation): citation is Citation => !!citation);
              if (citations.length === 0) continue;
              const messageId = runtime.response_message_id;
              setMessages((prev) =>
                prev.map((m) =>
                  m.message_id === messageId || m.message_id === assistantTempId
                    ? { ...m, citations: [...m.citations, ...citations] }
                    : m
                )
              );
              continue;
            }

            if (runtime.event_type === "response.completed") {
              const confidence = confidenceFromRuntime(runtime.payload.confidence);
              updateMessage(runtime.response_message_id, {
                status: "completed",
                confidence,
              });
              setStages((s) =>
                s.map((stage) =>
                  stage.label === "生成答案" ? { ...stage, done: true, running: false } : stage
                )
              );
              continue;
            }

            if (runtime.event_type === "followup.suggested") {
              const questions = runtime.payload.questions ?? runtime.payload.items;
              if (Array.isArray(questions)) {
                updateAssistantInStream({
                  follow_up_questions: questions
                    .map((item, index) => {
                      if (typeof item === "string") return { id: `followup-${index}`, text: item };
                      if (item && typeof item === "object") {
                        const text = (item as { text?: unknown }).text;
                        const id = (item as { id?: unknown }).id;
                        if (typeof text === "string") {
                          return {
                            id: typeof id === "string" ? id : `followup-${index}`,
                            text,
                          };
                        }
                      }
                      return null;
                    })
                    .filter((item): item is { id: string; text: string } => !!item),
                });
              }
              continue;
            }

            if (runtime.event_type === "usage.reported") {
              updateAssistantInStream({
                usage: {
                  input_tokens:
                    typeof runtime.payload.prompt_tokens === "number"
                      ? runtime.payload.prompt_tokens
                      : undefined,
                  output_tokens:
                    typeof runtime.payload.completion_tokens === "number"
                      ? runtime.payload.completion_tokens
                      : undefined,
                  total_tokens:
                    typeof runtime.payload.total_tokens === "number"
                      ? runtime.payload.total_tokens
                      : undefined,
                },
              });
              continue;
            }

            if (runtime.event_type === "execution.completed") {
              updateMessage(runtime.response_message_id, {
                status: "completed",
                duration_ms:
                  typeof runtime.payload.duration_ms === "number"
                    ? runtime.payload.duration_ms
                    : undefined,
              });
              setStages((s) => s.map((stage) => ({ ...stage, done: true, running: false })));
              continue;
            }

            if (runtime.event_type === "execution.cancelled") {
              updateMessage(runtime.response_message_id, { status: "cancelled" as MessageStatus });
              setStages((s) => s.map((stage) => ({ ...stage, running: false })));
              continue;
            }

            if (runtime.event_type === "execution.failed") {
              const error = runtime.payload.error as { message?: string } | undefined;
              updateMessage(runtime.response_message_id, {
                status: "failed",
                content: error?.message ?? "生成失败，请重试",
              });
              setStages((s) => s.map((stage) => ({ ...stage, running: false })));
              continue;
            }

            continue;
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
