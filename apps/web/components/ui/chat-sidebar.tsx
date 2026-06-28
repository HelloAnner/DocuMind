"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
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
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff < 7) return "近 7 天";
  return "更早";
}

function groupByDate(items: Conversation[]) {
  const groups = new Map<string, Conversation[]>();
  for (const item of items) {
    const label = formatGroupLabel(item.updated_at);
    groups.set(label, [...(groups.get(label) || []), item]);
  }
  const order = ["今天", "昨天", "近 7 天", "更早"];
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
  const { me } = useAuth();
  const {
    conversations,
    currentId,
    setCurrentId,
    createAndSelect,
    isFavorite,
    toggleFavorite,
    deleteConversation,
    refreshConversations,
  } = useConversation();

  const [search, setSearch] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const { aliases, setAlias } = useAliases();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const isSuperAdmin = isSuperAdminRole(me?.roles ?? []);
  const isTenantAdmin = isTenantAdminRole(me?.roles ?? []);
  const adminHref = isSuperAdmin ? "/system" : "/admin";
  const canAccessAdmin = isSuperAdmin || isTenantAdmin;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q))
      : conversations;
  }, [conversations, search]);

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
    router.push(`/chat?c=${encodeURIComponent(id)}`);
  };

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
          <MessageSquare size={14} className="dm-history-item-icon" />
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
        <Link className="dm-chat-logo" href="/chat">
          DocuMind
        </Link>
        <IconButton aria-label="新建问答" onClick={handleCreate}>
          <Plus size={16} />
        </IconButton>
      </div>

      <div className="dm-chat-search-wrap">
        <div className="dm-chat-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="搜索历史对话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="dm-chat-history">
        {favorites.length > 0 && (
          <div className="dm-history-group">
            <div className="dm-history-group-title">收藏</div>
            {favorites.map(renderItem)}
          </div>
        )}

        {filtered.length === 0 && (
          <div className="dm-history-empty">
            {search ? "未找到匹配的会话" : "暂无会话"}
          </div>
        )}

        {dateGroups.map(([label, items]) => (
          <div className="dm-history-group" key={label}>
            <div className="dm-history-group-title">{label}</div>
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
    </aside>
  );
}
