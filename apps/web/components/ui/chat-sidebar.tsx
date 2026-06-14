"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Folder, History, MessageSquare, Plus, Settings, Users } from "lucide-react";
import { IconButton } from "./icon-button";
import { useConversation } from "@/components/providers/conversation-provider";
import { useAuth } from "@/components/providers/auth-provider";

export function ChatSidebar() {
  const router = useRouter();
  const { me } = useAuth();
  const { conversations, currentId, setCurrentId, createAndSelect, availableKbs, selectedKbIds, setSelectedKbIds } = useConversation();
  const isAdmin = me?.roles.includes("tenant_admin") || me?.roles.includes("tenant_owner") || me?.roles.includes("super_admin");
  const selectedKb = availableKbs.find((k) => k.id === (selectedKbIds[0] ?? ""));

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
          <div className="dm-history-group">
            <div className="dm-history-group-title">最近</div>
            {conversations.map((item) => (
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
        )}
      </div>

      <div style={{ marginTop: "auto" }}>
        <Link className="dm-chat-admin-entry" href="/knowledge">
          <MessageSquare size={15} />
          <span>我可访问的知识库</span>
        </Link>
        <Link className="dm-chat-admin-entry" href="/history">
          <History size={15} />
          <span>历史问答</span>
        </Link>
        {isAdmin && (
          <Link className="dm-chat-admin-entry" href="/admin">
            <Settings size={15} />
            <span>管理后台</span>
          </Link>
        )}
      </div>
    </aside>
  );
}
