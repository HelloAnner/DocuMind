"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  Bookmark,
  FileClock,
  FolderOpen,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { IconButton } from "./icon-button";
import { useAuth } from "@/components/providers/auth-provider";
import { canAccessAdmin } from "@/lib/auth";
import { useConversation } from "@/components/providers/conversation-provider";
import type { Conversation } from "@/lib/types";
import { AppWindow, UserAccountMenu } from "./user-account-menu";
import { useChatShell } from "@/components/providers/chat-shell-provider";
import { ConfirmDialog } from "./confirm-dialog";
import { TenantSwitcher } from "./tenant-switcher";
import { BrandMark } from "./brand-mark";

const FAVORITES_KEY = "documind:conversation-aliases";

function formatGroupLabel(date: string) {
  const age = Date.now() - new Date(date).getTime();
  return age <= 7 * 86400000 ? "近 7 天" : "更早";
}

function groupByDate(items: Conversation[]) {
  const groups = new Map<string, Conversation[]>();
  for (const item of items) {
    const label = formatGroupLabel(item.updated_at);
    groups.set(label, [...(groups.get(label) || []), item]);
  }
  const order = ["近 7 天", "更早"];
  return Array.from(groups.entries()).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
}

function useAliases(tenantId: string | undefined) {
  const storageKey = `${FAVORITES_KEY}:${tenantId ?? "none"}`;
  const [aliases, setAliases] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setAliases(raw ? JSON.parse(raw) : {});
    } catch {
      setAliases({});
    }
  }, [storageKey]);
  const setAlias = (id: string, title: string | null) => {
    setAliases((prev) => {
      const next = { ...prev };
      if (title) next[id] = title;
      else delete next[id];
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };
  return { aliases, setAlias };
}

export function ChatSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, mobileOpen, closeMobile, toggleCollapsed } = useChatShell();
  const { me } = useAuth();
  const {
    conversations,
    currentId,
    setCurrentId,
    isFavorite,
    toggleFavorite,
    renameConversation,
    deleteConversation,
  } = useConversation();
  const canManageKnowledge = me?.scope === "tenant" && canAccessAdmin(me.roles);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [oldestFirst, setOldestFirst] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const { aliases, setAlias } = useAliases(me?.tenant?.id);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return conversations
      .filter((conversation) =>
        !needle || `${aliases[conversation.conversation_id] || conversation.title} ${conversation.last_message_preview || ""}`
          .toLocaleLowerCase()
          .includes(needle)
      )
      .sort((left, right) => {
        const difference = new Date(left.updated_at).getTime() - new Date(right.updated_at).getTime();
        return oldestFirst ? difference : -difference;
      });
  }, [aliases, conversations, oldestFirst, query]);

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

  const handleManagement = (href: string) => {
    setMenuId(null);
    closeMobile();
    router.push(href);
  };

  const handleSelect = (id: string) => {
    setMenuId(null);
    setCurrentId(id);
    closeMobile();
    router.push(`/chat?c=${encodeURIComponent(id)}`);
  };

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
          <IconButton
            aria-label={collapsed ? "展开会话导航" : "收起会话导航"}
            className="dm-chat-sidebar-collapse"
            onClick={toggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </IconButton>
          <IconButton aria-label="关闭会话导航" className="dm-chat-sidebar-mobile-close" onClick={closeMobile}>
            <X size={18} />
          </IconButton>
        </div>
      </div>

      <div className="dm-chat-workspace-switcher">
        <TenantSwitcher collapsed={collapsed} />
      </div>

      <div className="dm-chat-primary-actions">
        <button type="button" className="dm-new-session-button" onClick={handleCreate}>
          <Plus size={15} />
          <span>新任务</span>
        </button>
      </div>

      {canManageKnowledge ? (
        <nav aria-label="知识库" className="dm-chat-management">
          <button className={pathname.startsWith("/admin/knowledge") || pathname.startsWith("/admin/documents") ? "active" : ""} onClick={() => handleManagement("/admin/knowledge")} type="button">
            <FolderOpen size={17} />
            <span>知识库</span>
          </button>
          <button className={pathname.startsWith("/admin/document-jobs") ? "active" : ""} onClick={() => handleManagement("/admin/document-jobs")} type="button">
            <FileClock size={17} />
            <span>文档处理</span>
          </button>
        </nav>
      ) : null}

      <div className="dm-chat-history-toolbar">
        <span>对话</span>
        <div>
          <button
            aria-label={oldestFirst ? "按最新对话排序" : "按最早对话排序"}
            className={oldestFirst ? "active" : ""}
            onClick={() => setOldestFirst((value) => !value)}
            title={oldestFirst ? "当前：最早优先" : "当前：最新优先"}
            type="button"
          >
            <ArrowDownUp size={16} />
          </button>
          <button
            aria-label="搜索对话"
            className={searchOpen ? "active" : ""}
            onClick={() => {
              setSearchOpen((value) => !value);
              if (searchOpen) setQuery("");
            }}
            type="button"
          >
            <Search size={17} />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <label className="dm-chat-history-search">
          <Search aria-hidden="true" size={15} />
          <input
            aria-label="搜索对话"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索对话"
            value={query}
          />
        </label>
      ) : null}

      <div className="dm-chat-history">
        {favorites.length > 0 && (
          <div className="dm-history-group">
            <div className="dm-history-group-title">收藏</div>
            {favorites.map(renderItem)}
          </div>
        )}

        {filtered.length === 0 && (
          <div className="dm-history-empty">{query ? "没有匹配的对话" : "暂无对话"}</div>
        )}

        {dateGroups.map(([label, items]) => (
          <div className="dm-history-group" key={label}>
            <div className="dm-history-group-title">{label}</div>
            {items.map(renderItem)}
          </div>
        ))}
      </div>

      <div className="dm-chat-sidebar-footer">
        <UserAccountMenu onExplore={() => setExploreOpen(true)} />
      </div>

      {exploreOpen ? <AppWindow href="/help" onClose={() => setExploreOpen(false)} title="探索" /> : null}

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
        testId="conversation-delete-dialog"
        title="删除会话"
      />
    </aside>
  );
}
