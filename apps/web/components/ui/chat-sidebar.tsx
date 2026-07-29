"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  Headphones,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { IconButton } from "./icon-button";
import { useConversation } from "@/components/providers/conversation-provider";
import type { Conversation } from "@/lib/types";
import { UserAccountMenu } from "./user-account-menu";
import { useChatShell } from "@/components/providers/chat-shell-provider";
import { BrandMark } from "./brand-mark";
import { ThemeToggle } from "./theme-toggle";
import { ConfirmDialog } from "./confirm-dialog";

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

export function ChatSidebar() {
  const router = useRouter();
  const { collapsed, mobileOpen, closeMobile, toggleCollapsed } = useChatShell();
  const {
    conversations,
    currentId,
    setCurrentId,
    isFavorite,
    toggleFavorite,
    renameConversation,
    deleteConversation,
  } = useConversation();

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const { aliases, setAlias } = useAliases();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    setMenuId(null);
    setCurrentId(null);
    closeMobile();
    router.push("/chat");
  };

  const handleSelect = (id: string) => {
    setMenuId(null);
    setCurrentId(id);
    closeMobile();
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    router.push(`/chat?c=${encodeURIComponent(id)}`);
  };

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

  useEffect(() => {
    if (!menuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && openMenuRef.current?.contains(event.target)) return;
      setMenuId(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuId(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuId]);

  const handleRename = (conv: Conversation) => {
    setRenamingId(conv.conversation_id);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const finishRename = async (conv: Conversation, value: string) => {
    const title = value.trim();
    if (title && title !== displayTitle(conv)) {
      const renamed = await renameConversation(conv.conversation_id, title);
      if (renamed) {
        setAlias(conv.conversation_id, null);
      }
    }
    setRenamingId(null);
  };

  const handleDelete = (conv: Conversation) => {
    setDeleteError(null);
    setDeleteTarget({ ...conv, title: displayTitle(conv) });
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError(null);
    const deleted = await deleteConversation(target.conversation_id);
    if (deleted) {
      setAlias(target.conversation_id, null);
      setDeleteTarget(null);
      if (currentId === target.conversation_id) {
        closeMobile();
        router.replace("/chat");
      }
    } else {
      setDeleteError("删除失败，请稍后重试。");
    }
    setDeleting(false);
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
        className={`dm-history-item ${active ? "active" : ""} ${menuOpen ? "menu-open" : ""}`}
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
              onBlur={(e) => {
                void finishRename(conv, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") setRenamingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="dm-history-item-title">{displayTitle(conv)}</span>
          )}
          {unread && <span className="dm-history-item-dot" aria-hidden="true" />}
        </button>

        <div className="dm-history-item-actions" ref={menuOpen ? openMenuRef : undefined}>
          {(hovered || menuOpen || renaming) && !renaming && (
            <IconButton
              aria-label="会话操作"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
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
            <div className="dm-history-menu" onClick={(e) => e.stopPropagation()} role="menu">
              <button
                role="menuitem"
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
                role="menuitem"
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
                role="menuitem"
                onClick={() => {
                  setMenuId(null);
                  handleDelete(conv);
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
    <aside className={`dm-chat-sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="dm-chat-sidebar-header">
        <BrandMark />
        <div className="dm-chat-sidebar-header-actions">
          <ThemeToggle />
          <IconButton
            aria-label={collapsed ? "展开会话导航" : "收起会话导航"}
            className="dm-chat-sidebar-collapse"
            onClick={toggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
          <IconButton aria-label="关闭会话导航" className="dm-chat-sidebar-mobile-close" onClick={closeMobile}>
            <X size={17} />
          </IconButton>
        </div>
      </div>

      <div className="dm-chat-primary-actions">
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
        <UserAccountMenu />
      </div>

      <ConfirmDialog
        cancelText="取消"
        confirmText="删除"
        description={`确定要删除“${deleteTarget?.title ?? "未命名会话"}”吗？此操作无法撤销。`}
        error={deleteError}
        loading={deleting}
        onCancel={() => {
          if (deleting) return;
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => {
          void confirmDelete();
        }}
        open={deleteTarget !== null}
        title="删除会话"
      />
    </aside>
  );
}
