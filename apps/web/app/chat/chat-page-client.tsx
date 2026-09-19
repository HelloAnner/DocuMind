"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ChatWorkspace } from "@/components/views/chat-workspace";
import { useConversation } from "@/components/providers/conversation-provider";

export function ChatPageClient() {
  const searchParams = useSearchParams();
  const { setCurrentId } = useConversation();
  const creatingSkill = searchParams.get("create") === "skill";
  const conversationId = creatingSkill ? null : searchParams.get("c");

  useEffect(() => {
    setCurrentId(conversationId || null);
  }, [conversationId, setCurrentId]);

  return <ChatWorkspace
    key={creatingSkill ? "create-skill" : "chat"}
    initialInput={creatingSkill ? "请帮我创建一个可复用的企业技能。先询问我的使用场景、输入资料、执行步骤和期望输出，再一起完善技能名称、说明及 SKILL.md；如需脚本或参考文档，请说明用途。等我明确确认内容后，再调用 skill_save 保存到当前企业。我的需求是：" : ""}
  />;
}
