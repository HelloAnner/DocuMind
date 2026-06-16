"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Folder, Plus, Settings } from "lucide-react";
import { IconButton } from "./icon-button";
import { useConversation } from "@/components/providers/conversation-provider";
import { useAuth } from "@/components/providers/auth-provider";
import { defaultRouteForRole } from "@/lib/auth";

function groupConversationsByDate<T extends { updated_at: string; title: string; conversation_id: string }>(
  items: T[]
) {
  const groups = new Map<string, T[]>();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  for (const item of items) {
    const d = new Date(item.updated_at).toDateString();
    let label: string;
    if (d === today) label = "今天";
    else if (d === yesterday) label = "昨天";
    else label = new Date(item.updated_at).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
    groups.set(label, [...(groups.get(label) || []), item]);
  }

  const preferredOrder = ["今天", "昨天"];
  const sorted = Array.from(groups.entries()).sort(([a], [b]) => {
    const ai = preferredOrder.indexOf(a);
    const bi = preferredOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  return sorted;
}

export function ChatSidebar() {
  const router = useRouter();
  const { me } = useAuth();
  const {
    conversations,
    currentId,
    setCurrentId,
    createAndSelect,
    availableKbs,
    selectedKbIds,
    setSelectedKbIds,
  } = useConversation();

  const isSuperAdmin = me?.roles.includes("super_admin");
  const isAdmin =
    me?.roles.includes("enterprise_admin") ||
    me?.roles.includes("team_admin") ||
    me?.roles.includes("data_admin");
  const isTenantAdmin = me?.roles.includes("tenant_admin") || me?.roles.includes("tenant_owner");

  const adminHref = isSuperAdmin ? "/system" : isAdmin ? "/admin" : "/tenant";
  const canAccessAdmin = isSuperAdmin || isAdmin || isTenantAdmin;

  const selectedKb = availableKbs.find((k) => k.id === (selectedKbIds[0] ?? ""));
  const groups = groupConversationsByDate(conversations);

  const handleSelect = (id: string) => {
    setCurrentId(id);
    router.push(`/chat/${id}`);
  };

  const handleCreate = async () => {
    const id = await createAndSelect();
    if (id) {
      router.push(`/chat/${id}`);
    }
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

      <div className="dm-kb-selector">
        <Folder size={15} />
        <select
          value={selectedKbIds[0] ?? ""}
          onChange={(e) => setSelectedKbIds([e.target.value])}
          aria-label="选择知识库"
        >
          {availableKbs.map((kb) => (
            <option key={kb.id} value={kb.id}>
              {kb.name}
            </option>
          ))}
        </select>
        <ChevronDown size={14} />
      </div>

      <div className="dm-chat-history">
        {conversations.length === 0 ? (
          <div className="dm-history-group">
            <div className="dm-history-group-title">暂无会话</div>
          </div>
        ) : (
          groups.map(([label, items]) => (
            <div className="dm-history-group" key={label}>
              <div className="dm-history-group-title">{label}</div>
              {items.map((item) => (
                <button
                  className={`dm-history-item ${item.conversation_id === currentId ? "active" : ""}`}
                  key={item.conversation_id}
                  type="button"
                  onClick={() => handleSelect(item.conversation_id)}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ))
        )}
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
