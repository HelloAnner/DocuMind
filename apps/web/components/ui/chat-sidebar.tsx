"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  Headphones,
  MoreHorizontal,
  Pencil,
  Settings,
  Trash2,
} from "lucide-react";
import { IconButton } from "./icon-button";
import { useConversation } from "@/components/providers/conversation-provider";
import { useAuth } from "@/components/providers/auth-provider";
import { isSuperAdminRole, isTenantAdminRole } from "@/lib/auth";
import type { Conversation } from "@/lib/types";

const FAVORITES_KEY = "documind:conversation-aliases";

function formatGroupLabel(date: string) {
  const d = new Date(date);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (d.toDateString() === today) return "今天";
  if (d.toDateString() === yesterday) return "昨天";
  return "更早";
}

function groupByDate(items: Conversation[]) {
  const groups = new Map<string, Conversation[]>();
  for (const item of items) {
    const label = formatGroupLabel(item.updated_at);
    groups.set(label, [...(groups.get(label) || []), item]);
  }
  const order = ["今天", "昨天", "更早"];
  return Array.from(groups.entries()).sort(([a], [b]) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

function useAliases() {
  const [aliases, setAliases] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      if (raw) setAliases(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, []);
  const setAlias = (id: string, title: string | null) => {
    setAliases((prev) => {
      const next = { ...prev };
      if (title) next[id] = title;
      else delete next[id];
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };
  return { aliases, setAlias };
}

interface ChatSidebarProps {
  width?: number;
  onResize?: (width: number) => void;
}

export function ChatSidebar({ width, onResize }: ChatSidebarProps) {
  const router = useRouter();
  const { me } = useAuth();
  const {
    conversations,
    currentId,
    setCurrentId,
    createAndSelect,
    isFavorite,
    toggleFavorite,
    deleteConversation,
  } = useConversation();

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const { aliases, setAlias } = useAliases();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());

  const isSuperAdmin = isSuperAdminRole(me?.roles ?? []);
  const isTenantAdmin = isTenantAdminRole(me?.roles ?? []);
  const adminHref = isSuperAdmin ? "/system" : "/admin";
  const canAccessAdmin = isSuperAdmin || isTenantAdmin;

  const filtered = useMemo(() => conversations, [conversations]);

  const favorites = useMemo(
    () => filtered.filter((c) => isFavorite(c.conversation_id)),
    [filtered, isFavorite]
  );
  const nonFavorites = useMemo(
    () => filtered.filter((c) => !isFavorite(c.conversation_id)),
    [filtered]
  );
  const dateGroups = useMemo(() => groupByDate(nonFavorites), [nonFavorites]);

  const handleCreate = () => {
    setCurrentId(null);
    router.push("/chat");
  };

  const handleSelect = (id: string) => {
    setCurrentId(id);
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    router.push(`/chat?c=${encodeURIComponent(id)}`);
  };

  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(0);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = (e: React.MouseEvent | React.TouchEvent) => {
    if (!onResize) return;
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    resizeStartX.current = clientX;
    resizeStartWidth.current = width ?? 244;
    setIsResizing(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (e: MouseEvent | TouchEvent) => {
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const delta = clientX - resizeStartX.current;
      onResize?.(resizeStartWidth.current + delta);
    };

    const handleUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("touchmove", handleMove, { passive: true });
    window.addEventListener("touchend", handleUp);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleUp);
    };
  }, [isResizing, onResize]);

  useEffect(() => {
    if (unreadIds.size > 0 || conversations.length === 0) return;
    const today = new Date().toDateString();
    const firstToday = conversations.find(
      (c) =>
        new Date(c.updated_at).toDateString() === today &&
        c.conversation_id !== currentId
    );
    if (firstToday) {
      setUnreadIds(new Set([firstToday.conversation_id]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, currentId]);

  const handleRename = (conv: Conversation) => {
    setRenamingId(conv.conversation_id);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const finishRename = (conv: Conversation, value: string) => {
    const title = value.trim();
    if (title && title !== conv.title) {
      setAlias(conv.conversation_id, title);
    }
    setRenamingId(null);
  };

  const handleDelete = async (conv: Conversation) => {
    if (!confirm(`确定删除会话「${conv.title}」吗？`)) return;
    await deleteConversation(conv.conversation_id);
    if (currentId === conv.conversation_id) {
      router.push("/chat");
    }
  };

  const displayTitle = (conv: Conversation) => aliases[conv.conversation_id] || conv.title;

  const renderItem = (conv: Conversation) => {
    const active = conv.conversation_id === currentId;
    const favorited = isFavorite(conv.conversation_id);
    const hovered = hoveredId === conv.conversation_id;
    const menuOpen = menuId === conv.conversation_id;
    const renaming = renamingId === conv.conversation_id;
    const unread = unreadIds.has(conv.conversation_id);

    return (
      <div
        key={conv.conversation_id}
        className={`dm-history-item ${active ? "active" : ""}`}
        onMouseEnter={() => setHoveredId(conv.conversation_id)}
        onMouseLeave={() => setHoveredId((id) => (id === conv.conversation_id ? null : id))}
      >
        <button
          type="button"
          className="dm-history-item-main"
          onClick={() => handleSelect(conv.conversation_id)}
        >
          {renaming ? (
            <input
              ref={renameInputRef}
              className="dm-history-item-input"
              defaultValue={displayTitle(conv)}
              onBlur={(e) => finishRename(conv, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishRename(conv, e.currentTarget.value);
                if (e.key === "Escape") setRenamingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="dm-history-item-title">{displayTitle(conv)}</span>
          )}
          {unread && <span className="dm-history-item-dot" aria-hidden="true" />}
        </button>

        <div className="dm-history-item-actions">
          {(hovered || menuOpen || renaming) && !renaming && (
            <IconButton
              aria-label="会话操作"
              className="dm-history-item-action dm-history-menu-trigger"
              onClick={(e) => {
                e.stopPropagation();
                setMenuId((id) => (id === conv.conversation_id ? null : conv.conversation_id));
              }}
            >
              <MoreHorizontal size={18} />
            </IconButton>
          )}
          {menuOpen && (
            <div className="dm-history-menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => {
                  setMenuId(null);
                  handleRename(conv);
                }}
              >
                <Pencil size={18} />
                <span>重命名</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuId(null);
                  toggleFavorite(conv.conversation_id);
                }}
              >
                <Bookmark size={18} fill={favorited ? "currentColor" : "none"} />
                <span>{favorited ? "取消收藏" : "收藏"}</span>
              </button>
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  setMenuId(null);
                  await handleDelete(conv);
                }}
              >
                <Trash2 size={18} />
                <span>删除</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside className="dm-chat-sidebar">
      <div className="dm-sidebar-top">
        <button type="button" className="dm-new-session-button" onClick={handleCreate}>
          <Headphones size={18} />
          <span>新会话</span>
        </button>
      </div>

      <div className="dm-chat-history">
        {favorites.length > 0 && (
          <div className="dm-history-group">
            <div className="dm-history-group-title">
              <span>收藏</span>
              <ChevronDown size={14} />
            </div>
            {favorites.map(renderItem)}
          </div>
        )}

        {filtered.length === 0 && (
          <div className="dm-history-empty">暂无会话</div>
        )}

        {dateGroups.map(([label, items]) => (
          <div className="dm-history-group" key={label}>
            <div className="dm-history-group-title">
              <span>{label}</span>
              <ChevronDown size={14} />
            </div>
            {items.map(renderItem)}
          </div>
        ))}
      </div>

      <div style={{ marginTop: "auto" }}>
        {canAccessAdmin && (
          <Link className="dm-chat-admin-entry" href={adminHref}>
            <Settings size={15} />
            <span>管理后台</span>
          </Link>
        )}
      </div>

      {onResize && (
        <div
          className="dm-sidebar-resize-handle"
          data-resizing={isResizing}
          onMouseDown={startResize}
          onTouchStart={startResize}
          role="separator"
          aria-label="调整侧边栏宽度"
        />
      )}
    </aside>
  );
}
