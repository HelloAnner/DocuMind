"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Badge } from "./badge";
import { IconButton } from "./icon-button";

const tabs = ["文档信息", "切片列表 (47)", "操作记录"];

const chunks = Array.from({ length: 8 }).map((_, index) => ({
  id: `chunk_014_00${index + 1}`,
  page: 3 + index,
  title: "Q1 目标 > 分地区策略",
  content:
    "Q1 华东区域销售目标为 1200 万元，较去年同期增长 15%，其中新客户占比不低于 30%。华南区域目标为 980 万元...",
}));

export function DocumentDrawer({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState(1);

  return (
    <div className="dm-drawer-overlay" onClick={onClose}>
      <aside className="dm-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="dm-drawer-head">
          <div className="dm-drawer-head-row">
            <h2>2025年度销售策略.pptx</h2>
            <IconButton onClick={onClose} aria-label="关闭">
              <X size={18} />
            </IconButton>
          </div>
          <div className="dm-drawer-meta">
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>PPTX · 2.4 MB · 47 切片</span>
            <Badge tone="success">已完成</Badge>
          </div>
        </div>

        <div className="dm-drawer-tabs">
          {tabs.map((tab, index) => (
            <button
              key={tab}
              className={activeTab === index ? "active" : ""}
              onClick={() => setActiveTab(index)}
              type="button"
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="dm-drawer-body">
          {chunks.map((chunk) => (
            <div className="dm-chunk-row" key={chunk.id}>
              <span>
                切片 #{chunk.id.split("_").pop()} · 第 {chunk.page} 页
              </span>
              <strong>{chunk.title}</strong>
              <p>{chunk.content}</p>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
