"use client";

import { ArrowUpRight, Sparkles } from "lucide-react";
import type { RuntimeToolCall } from "@/lib/types";

export function SkillCard({ toolCalls }: { toolCalls?: RuntimeToolCall[] }) {
  const call = toolCalls?.find((tool) => tool.name === "skill_save" && tool.status === "succeeded");
  if (!call || !call.result || typeof call.result !== "object") return null;
  const result = call.result as Record<string, unknown>;
  const interaction = result.interaction;
  if (!interaction || typeof interaction !== "object") return null;
  const skillValue = (interaction as Record<string, unknown>).skill;
  if (!skillValue || typeof skillValue !== "object") return null;
  const skill = skillValue as Record<string, unknown>;
  return (
    <section className="dm-skill-conversation-card">
      <div className="dm-skill-conversation-head">
        <span><Sparkles size={20} /></span>
        <div><small>SKILL CREATED</small><strong>{String(skill.display_name ?? "技能已创建")}</strong><code>{String(skill.name ?? "")}</code></div>
      </div>
      <p>{String(skill.description ?? "此技能已自动加入当前租户的全部对话。")}</p>
      <a href="/admin/skills">查看技能 <ArrowUpRight size={14} /></a>
    </section>
  );
}
