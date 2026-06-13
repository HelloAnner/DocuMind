"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Topbar } from "@/components/ui/topbar";

const strategies = [
  { id: "struct", name: "结构感知", desc: "按标题、小节、表格边界切分" },
  { id: "recursive", name: "递归切分", desc: "按段落/句子递归切分" },
  { id: "fixed", name: "固定大小", desc: "按固定 token 数切分" },
];

const parameters = [
  { label: "最大切片大小", value: "1500", suffix: "tokens" },
  { label: "重叠长度", value: "300", suffix: "tokens" },
  { label: "段落分隔符", value: "\\n\\n", suffix: "正则" },
];

const checkboxes = [
  { id: "table", label: "保留表格结构", checked: true },
  { id: "list", label: "保留列表层级", checked: true },
  { id: "merge", label: "合并短段落（< 50 tokens）", checked: true },
];

export function ConfigChunking() {
  const [selected, setSelected] = useState("struct");
  const [checks, setChecks] = useState<Record<string, boolean>>({
    table: true,
    list: true,
    merge: true,
  });

  return (
    <>
      <Topbar title="切割策略">
        <Button>保存</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>控制文档如何被切分为语义片段。合理的切分策略能显著提升检索准确率。</p>

          <div className="dm-config-cards">
            {strategies.map((strategy) => (
              <button
                key={strategy.id}
                className={`dm-config-card ${selected === strategy.id ? "selected" : ""}`}
                onClick={() => setSelected(strategy.id)}
                type="button"
              >
                <strong>{strategy.name}</strong>
                <p>{strategy.desc}</p>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {parameters.map((param) => (
              <div className="dm-field-row" key={param.label}>
                <span>{param.label}</span>
                <div className="dm-field-suffix">
                  <input defaultValue={param.value} />
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{param.suffix}</span>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {checkboxes.map((item) => (
              <label className="dm-check-row" key={item.id}>
                <input
                  checked={checks[item.id]}
                  onChange={(e) => setChecks((prev) => ({ ...prev, [item.id]: e.target.checked }))}
                  type="checkbox"
                />
                {item.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
