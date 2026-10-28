"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ReadonlyField } from "@/components/ui/readonly-field";
import { Topbar } from "@/components/ui/topbar";
import { getAdminRuntimeConfig, type AdminRuntimeConfig } from "@/lib/api";

const strategyCards = [
  { id: "structure_aware", name: "结构感知", desc: "按标题、小节、表格边界切分" },
  { id: "recursive", name: "递归切分", desc: "按段落和句子递归切分" },
  { id: "fixed", name: "固定大小", desc: "按固定 token 数切分" },
];

export function ConfigChunking() {
  const [config, setConfig] = useState<AdminRuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminRuntimeConfig()
      .then(setConfig)
      .catch((err) => setError(err instanceof Error ? err.message : "配置加载失败"));
  }, []);

  const chunking = config?.chunking;
  const parameters = chunking
    ? [
        { label: "目标切片大小", value: chunking.target_chunk_tokens, suffix: "tokens" },
        { label: "最大切片大小", value: chunking.max_chunk_tokens, suffix: "tokens" },
        { label: "硬切分阈值", value: chunking.hard_split_tokens, suffix: "tokens" },
        { label: "最小切片大小", value: chunking.min_chunk_tokens, suffix: "tokens" },
        { label: "重叠长度", value: chunking.overlap_tokens, suffix: "tokens" },
        { label: "单片最大表格行数", value: chunking.max_table_rows_per_chunk, suffix: "行" },
        { label: "单片最大表格 token", value: chunking.max_table_token_per_chunk, suffix: "tokens" },
      ]
    : [];

  const checks = chunking
    ? [
        { label: "保留表格结构", checked: chunking.preserve_table_structure },
        { label: "保留列表层级", checked: chunking.preserve_list_hierarchy },
        { label: "合并短文本块", checked: chunking.merge_short_blocks },
      ]
    : [];

  return (
    <>
      <Topbar title="切割策略">
        <Badge tone="neutral">只读配置</Badge>
      </Topbar>

      <div className="dm-admin-content dm-settings-page">
        <div className="dm-config-content">
          <p className="dm-config-intro">当前运行参数来自服务器环境变量，配置变更需走部署流程。</p>
          {error ? <p className="dm-form-note" style={{ color: "var(--color-error)" }}>{error}</p> : null}
          {!config && !error ? <div className="dm-empty-state">加载切割配置中...</div> : null}

          <section className="dm-config-section">
            <div>
              <div className="dm-config-section-title">切分方式</div>
              <p className="dm-config-section-description">当前策略决定文档如何按结构边界拆分为可检索片段。</p>
            </div>
            <div className="dm-config-cards">
              {strategyCards.map((strategy) => (
                <button
                  key={strategy.id}
                  className={`dm-config-card ${chunking?.strategy === strategy.id ? "selected" : ""}`}
                  disabled
                  type="button"
                >
                  <strong>{strategy.name}</strong>
                  <p>{strategy.desc}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="dm-config-section">
            <div className="dm-config-section-title">切片参数</div>
            <div className="dm-config-stack">
              {parameters.map((param) => (
                <ReadonlyField key={param.label} label={param.label} value={`${param.value} ${param.suffix}`} />
              ))}
            </div>
          </section>

          <section className="dm-config-section">
            <div className="dm-config-section-title">结构保留</div>
            <div className="dm-config-checks">
              {checks.map((item) => (
                <label className="dm-check-row" key={item.label}>
                  <input checked={item.checked} disabled readOnly type="checkbox" />
                  {item.label}
                </label>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
