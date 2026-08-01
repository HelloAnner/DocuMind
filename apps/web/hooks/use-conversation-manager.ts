"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelMessage,
  createConversation,
  deleteFeedback,
  deleteConversation,
  getMessages,
  listConversations,
  listKnowledgeBases,
  renameConversation,
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
  RuntimeReasoningStep,
  RuntimeToolCall,
  RuntimeEventEnvelope,
  SendMessageRequest,
} from "@/lib/types";

type MessageListUpdate = (messages: Message[]) => Message[];

function isRuntimeEvent(data: unknown): data is RuntimeEventEnvelope {
  if (!data || typeof data !== "object") return false;
  const event = data as Partial<RuntimeEventEnvelope>;
  return event.schema_version === "moss.execution.event.v1" && typeof event.event_type === "string";
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

function runtimeStepNumber(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function useConversationManager() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(false);
  const [availableKbs, setAvailableKbs] = useState<KnowledgeBase[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const pendingRef = useRef<{ userTempId: string; assistantTempId: string } | null>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const requestActiveRef = useRef(false);
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

  useEffect(() => {
    if (!currentId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    if (skipLoadRef.current === currentId) {
      skipLoadRef.current = null;
      return;
    }

    let active = true;
    setMessages([]);
    setLoading(true);
    getMessages(currentId)
      .then((response) => {
        if (active) setMessages(response.messages);
      })
      .catch((error) => {
        if (active) console.error("failed to load messages", error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [currentId]);

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

      let assistantId = assistantTempId;
      let activeReasoningStep: number | null = null;
      let pendingMessageUpdates: MessageListUpdate[] = [];
      let pendingMessageFrame: number | null = null;
      const applyPendingMessageUpdates = () => {
        const updates = pendingMessageUpdates;
        pendingMessageUpdates = [];
        if (updates.length === 0) return;
        setMessages((current) => updates.reduce((messages, update) => update(messages), current));
      };
      const flushPendingMessageUpdates = () => {
        if (pendingMessageFrame !== null && typeof window !== "undefined") {
          window.cancelAnimationFrame(pendingMessageFrame);
        }
        pendingMessageFrame = null;
        applyPendingMessageUpdates();
      };
      const queueMessageUpdate = (update: MessageListUpdate) => {
        pendingMessageUpdates.push(update);
        if (pendingMessageFrame !== null) return;
        if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
          applyPendingMessageUpdates();
          return;
        }
        // 与 Moss 一致：把同一动画帧内的 token、thinking 和工具事件合并成一次 React 提交。
        pendingMessageFrame = window.requestAnimationFrame(() => {
          pendingMessageFrame = null;
          applyPendingMessageUpdates();
        });
      };
      const updateAssistantInStream = (patch: Partial<Message>) => {
        const messageId = assistantId;
        queueMessageUpdate((prev) =>
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
        queueMessageUpdate((prev) =>
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
      const updateReasoningStepInStream = (
        stepNumber: number,
        recipe: (step?: RuntimeReasoningStep) => RuntimeReasoningStep
      ) => {
        const messageId = assistantId;
        queueMessageUpdate((prev) =>
          prev.map((m) => {
            if (m.message_id !== messageId && m.message_id !== assistantTempId) return m;
            const steps = m.reasoning_steps ?? [];
            const exists = steps.some((step) => step.step === stepNumber);
            const nextSteps = exists
              ? steps.map((step) => (step.step === stepNumber ? recipe(step) : step))
              : [...steps, recipe(undefined)];
            return { ...m, reasoning_steps: nextSteps };
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

            if (runtime.event_type === "response.stage") {
              const stage = runtime.payload.stage;
              if (typeof stage === "string") updateAssistantInStream({ runtime_stage: stage });
              continue;
            }

            if (runtime.event_type === "agent.step.started") {
              const stepNumber = runtimeStepNumber(runtime.payload.step);
              if (stepNumber !== null) {
                activeReasoningStep = stepNumber;
                const action = firstRuntimeString(runtime.payload.action, "tool");
                const decisionSummary = firstRuntimeString(runtime.payload.decision_summary);
                const messageId = assistantId;
                queueMessageUpdate((current) =>
                  current.map((message) => {
                    if (
                      message.message_id !== messageId &&
                      message.message_id !== assistantTempId
                    ) return message;
                    const steps = message.reasoning_steps ?? [];
                    const existing = steps.find((step) => step.step === stepNumber);
                    const interimOutput = action === "tool" ? message.content.trim() : "";
                    const nextStep: RuntimeReasoningStep = {
                      step: stepNumber,
                      action,
                      decision_summary: decisionSummary,
                      output: interimOutput || existing?.output,
                      tool_calls: existing?.tool_calls ?? [],
                      warnings: existing?.warnings,
                      started_at: existing?.started_at ?? runtime.occurred_at,
                      completed_at: existing?.completed_at,
                    };
                    return {
                      ...message,
                      content: interimOutput ? "" : message.content,
                      reasoning_steps: existing
                        ? steps.map((step) => step.step === stepNumber ? nextStep : step)
                        : [...steps, nextStep],
                    };
                  })
                );
              }
              continue;
            }

            if (runtime.event_type === "thinking.delta") {
              // Raw model reasoning is intentionally not rendered. The visible trace is
              // assembled from real step, tool argument, result, and final-response events.
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
              // Preview events describe a possible call; only started/result events are real calls.
              continue;
            }

            if (runtime.event_type === "tool.call.started") {
              const toolId = runtimeToolId(runtime);
              if (toolId) {
                updateToolCallInStream(toolId, (tool) => ({
                  id: toolId,
                  name: runtimeToolName(runtime, tool?.name ?? toolId),
                  arguments: runtime.payload.arguments ?? tool?.arguments,
                  arguments_preview: tool?.arguments_preview,
                  status: "running",
                  step: tool?.step ?? activeReasoningStep ?? undefined,
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
                step: tool?.step ?? activeReasoningStep ?? undefined,
                progress: typeof progress === "number" ? progress : tool?.progress,
                message: typeof message === "string" ? message : tool?.message,
                started_at: tool?.started_at,
                display: runtime.payload.display ?? tool?.display,
              }));
              continue;
            }

            if (
              runtime.event_type === "tool.call.result" ||
              runtime.event_type === "tool.call.failed"
            ) {
              const toolId = runtimeToolId(runtime);
              if (toolId) {
                updateToolCallInStream(toolId, (tool) => ({
                  id: toolId,
                  name: runtimeToolName(runtime, tool?.name ?? toolId),
                  arguments: runtime.payload.arguments ?? tool?.arguments,
                  arguments_preview: tool?.arguments_preview,
                  status:
                    runtime.event_type === "tool.call.failed"
                      ? "failed"
                      : normalizeToolStatus(runtime.payload.status),
                  result: runtime.payload.result ?? tool?.result,
                  error: runtime.payload.error ?? tool?.error,
                  step: tool?.step ?? activeReasoningStep ?? undefined,
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
              queueMessageUpdate((prev) =>
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
              queueMessageUpdate((prev) =>
                prev.map((m) =>
                  m.message_id === messageId || m.message_id === assistantTempId
                    ? { ...m, citations: [...m.citations, ...citations] }
                    : m
                )
              );
              continue;
            }

            if (runtime.event_type === "response.completed") {
              flushPendingMessageUpdates();
              const confidence = confidenceFromRuntime(runtime.payload.confidence);
              updateMessage(runtime.response_message_id, {
                status: "completed",
                confidence,
                runtime_stage: undefined,
              });
              continue;
            }

            if (runtime.event_type === "conversation.title.updated") {
              const conversationTitle = runtime.payload.title;
              const updatedConversationId = runtime.payload.conversation_id;
              if (
                typeof conversationTitle === "string" &&
                typeof updatedConversationId === "string"
              ) {
                setConversations((current) =>
                  current.map((conversation) =>
                    conversation.conversation_id === updatedConversationId
                      ? { ...conversation, title: conversationTitle }
                      : conversation
                  )
                );
              }
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
              flushPendingMessageUpdates();
              updateMessage(runtime.response_message_id, {
                status: "completed",
                duration_ms:
                  typeof runtime.payload.duration_ms === "number"
                    ? runtime.payload.duration_ms
                    : undefined,
              });
              abortControllersRef.current.delete(runtime.response_message_id);
              setStreamingId((current) =>
                current === runtime.response_message_id ? null : current
              );
              continue;
            }

            if (runtime.event_type === "execution.cancelled") {
              flushPendingMessageUpdates();
              updateMessage(runtime.response_message_id, { status: "cancelled" as MessageStatus });
              continue;
            }

            if (runtime.event_type === "execution.failed") {
              flushPendingMessageUpdates();
              const error = runtime.payload.error as { message?: string } | undefined;
              updateMessage(runtime.response_message_id, {
                status: "failed",
                content: error?.message ?? "生成失败，请重试",
              });
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
          } else if (sse.event === "answer.delta") {
            const data = sse.data as { message_id: string; text: string };
            queueMessageUpdate((prev) =>
              prev.map((m) =>
                m.message_id === data.message_id || m.message_id === assistantTempId
                  ? { ...m, content: m.content + data.text }
                  : m
              )
            );
          } else if (sse.event === "citation.delta") {
            const data = sse.data as { message_id: string; citation: Citation };
            queueMessageUpdate((prev) =>
              prev.map((m) =>
                m.message_id === data.message_id || m.message_id === assistantTempId
                  ? { ...m, citations: [...m.citations, data.citation] }
                  : m
              )
            );
          } else if (sse.event === "answer.completed") {
            flushPendingMessageUpdates();
            const data = sse.data as {
              message_id: string;
              confidence: "high" | "medium" | "low";
            };
            updateMessage(data.message_id, {
              status: "completed",
              confidence: data.confidence,
            });
            abortControllersRef.current.delete(data.message_id);
            setStreamingId((current) => (current === data.message_id ? null : current));
          } else if (sse.event === "conversation.title.updated") {
            const data = sse.data as { conversation_id?: string; title?: string };
            if (data.conversation_id && data.title) {
              setConversations((current) =>
                current.map((conversation) =>
                  conversation.conversation_id === data.conversation_id
                    ? { ...conversation, title: data.title as string }
                    : conversation
                )
              );
            }
          } else if (sse.event === "answer.failed") {
            flushPendingMessageUpdates();
            const data = sse.data as { message_id: string; code: string; message: string };
            updateMessage(data.message_id, {
              status: "failed",
              content: data.message,
            });
          }
        }
      } catch (e) {
        flushPendingMessageUpdates();
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
        flushPendingMessageUpdates();
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
      if (requestActiveRef.current) return;
      requestActiveRef.current = true;
      try {
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
        const controller = new AbortController();
        await processStream(
          conversationId,
          content,
          req,
          sendMessageStreamUrl(conversationId),
          controller,
          false
        );
      } finally {
        requestActiveRef.current = false;
      }
    },
    [currentId, createAndSelect, processStream]
  );

  const retryMessage = useCallback(
    async (messageId: string) => {
      if (!currentId || requestActiveRef.current) return;
      requestActiveRef.current = true;
      try {
        const controller = new AbortController();
        const url = retryMessageStreamUrl(currentId, messageId);
        const req: RetryMessageRequest = { stream: true };
        await processStream(currentId, "", req, url, controller, true);
      } finally {
        requestActiveRef.current = false;
      }
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
      if (!currentId) return false;
      try {
        const feedback = await submitFeedback(currentId, messageId, {
          rating,
          reason,
          comment,
          correction,
        });
        updateMessage(messageId, { feedback });
        return true;
      } catch (e) {
        console.error("feedback failed", e);
        return false;
      }
    },
    [currentId, updateMessage]
  );

  const doClearFeedback = useCallback(
    async (messageId: string) => {
      if (!currentId) return false;
      try {
        await deleteFeedback(currentId, messageId);
        updateMessage(messageId, { feedback: undefined });
        return true;
      } catch (e) {
        console.error("clear feedback failed", e);
        return false;
      }
    },
    [currentId, updateMessage]
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
          if (streamingId) {
            abortControllersRef.current.get(streamingId)?.abort();
            abortControllersRef.current.delete(streamingId);
            setStreamingId(null);
          }
          setCurrentId(null);
          setMessages([]);
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
        return true;
      } catch (e) {
        console.error("delete conversation failed", e);
        return false;
      }
    },
    [currentId]
  );

  const doRenameConversation = useCallback(async (conversationId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return false;
    try {
      const updated = await renameConversation(conversationId, nextTitle);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.conversation_id === conversationId
            ? { ...conversation, title: updated.title }
            : conversation
        )
      );
      return true;
    } catch (error) {
      console.error("rename conversation failed", error);
      return false;
    }
  }, []);

  return {
    conversations,
    currentId,
    messages,
    loading,
    streamingId,
    rightOpen,
    setRightOpen,
    setCurrentId,
    availableKbs,
    createAndSelect,
    sendMessage,
    retryMessage,
    cancelMessage: doCancelMessage,
    submitFeedback: doSubmitFeedback,
    clearFeedback: doClearFeedback,
    refreshConversations: loadConversations,
    isFavorite,
    toggleFavorite,
    renameConversation: doRenameConversation,
    deleteConversation: doDeleteConversation,
  };
}
