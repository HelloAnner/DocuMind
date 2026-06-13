"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KnowledgeCard } from "@/components/ui/knowledge-card";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";

const knowledgeBases = [
  { name: "产品文档库", desc: "面向全公司的产品手册与白皮书集合", docs: 128, chunks: 4832 },
  { name: "销售资料库", desc: "销售策略、报价单与合同模板", docs: 86, chunks: 2156 },
  { name: "人力资源库", desc: "员工手册、报销政策与规章制度", docs: 42, chunks: 890 },
  { name: "研发规范库", desc: "技术文档、安全规范与 API 文档", docs: 64, chunks: 1634 },
  { name: "法务合规章", desc: "合同范本、合规要求与审批流程", docs: 35, chunks: 720 },
  { name: "市场活动库", desc: "活动策划、品牌规范与竞品分析", docs: 28, chunks: 560 },
];

export function AdminKnowledge() {
  return (
    <>
      <Topbar title="知识库管理">
        <Button icon={<Plus size={14} />}>新建知识库</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索知识库..." />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {knowledgeBases.length} 个知识库</span>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {knowledgeBases.map((kb) => (
            <KnowledgeCard key={kb.name} {...kb} />
          ))}
        </div>
      </div>
    </>
  );
}
