"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Folder, Plus, Settings } from "lucide-react";
import { IconButton } from "./icon-button";
import { useConversation } from "@/components/providers/conversation-provider";

export function ChatSidebar() {
  const router = useRouter();
  const { conversations, currentId, setCurrentId, createAndSelect } = useConversation();

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
        <span>产品文档库</span>
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

      <Link className="dm-chat-admin-entry" href="/admin">
        <Settings size={15} />
        <span>管理后台</span>
      </Link>
    </aside>
  );
}
