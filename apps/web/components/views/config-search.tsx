"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Topbar } from "@/components/ui/topbar";

const strategies = ["Dense + BM25", "Dense Only", "BM25 Only"];

const fields = [
  { label: "检索 Top-K", value: "100", suffix: "个" },
  { label: "精排 Top-K", value: "20", suffix: "个" },
  { label: "相似度阈值", value: "0.30", suffix: "分" },
  { label: "RRF 融合系数 k", value: "60", suffix: "" },
];

export function ConfigSearch() {
  const [strategy, setStrategy] = useState("Dense + BM25");

  return (
    <>
      <Topbar title="检索参数">
        <Button>保存</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>配置混合检索与重排序策略，平衡召回率与精确率。</p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {fields.map((field) => (
              <div className="dm-field-row" key={field.label}>
                <span>{field.label}</span>
                <div className="dm-field-suffix">
                  <input defaultValue={field.value} />
                  {field.suffix && <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{field.suffix}</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="dm-config-section">
            <div className="dm-config-section-title">检索策略</div>
            <div className="dm-option-strip">
              {strategies.map((s) => (
                <button
                  key={s}
                  className={strategy === s ? "selected" : ""}
                  onClick={() => setStrategy(s)}
                  type="button"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="dm-config-section">
            <div className="dm-config-section-title">重排序模型</div>
            <button className="dm-field-row" type="button" style={{ width: "100%", cursor: "pointer" }}>
              <span>bge-reranker-v2-m3 (本地)</span>
              <ChevronRight size={16} style={{ color: "var(--text-muted)" }} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
