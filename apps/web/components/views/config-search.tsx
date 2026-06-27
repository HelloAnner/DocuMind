"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Topbar } from "@/components/ui/topbar";
import { getAdminRuntimeConfig, type AdminRuntimeConfig } from "@/lib/api";

const strategies = ["Dense + BM25 + RRF", "Dense Only", "BM25 Only"];

export function ConfigSearch() {
  const [config, setConfig] = useState<AdminRuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminRuntimeConfig()
      .then(setConfig)
      .catch((err) => setError(err instanceof Error ? err.message : "配置加载失败"));
  }, []);

  const search = config?.search;
  const fields = search
    ? [
        { label: "Dense Top-K", value: search.dense_top_k, suffix: "个" },
        { label: "BM25 Top-K", value: search.bm25_top_k, suffix: "个" },
        { label: "RRF Top-K", value: search.rrf_top_k, suffix: "个" },
        { label: "最终上下文 Top-K", value: search.effective_top_k, suffix: "个" },
        { label: "精排阈值", value: search.rerank_min_score, suffix: "分" },
      ]
    : [];

  return (
    <>
      <Topbar title="检索参数">
        <Badge tone={search?.rerank_enabled ? "success" : "neutral"}>
          {search?.rerank_enabled ? "精排已启用" : "精排未启用"}
        </Badge>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>当前检索参数来自服务器环境变量，修改需通过部署生效。</p>
          {error ? <p className="dm-form-note" style={{ color: "var(--color-error)" }}>{error}</p> : null}
          {!config && !error ? <div className="dm-empty-state">加载检索配置中...</div> : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {fields.map((field) => (
              <div className="dm-field-row" key={field.label}>
                <span>{field.label}</span>
                <div className="dm-field-suffix">
                  <input readOnly value={field.value} />
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
                  className={search?.strategy === s ? "selected" : ""}
                  disabled
                  type="button"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="dm-config-section">
            <div className="dm-config-section-title">重排序模型</div>
            <button className="dm-field-row" disabled type="button" style={{ width: "100%", cursor: "default" }}>
              <span>
                {search?.rerank_model ?? ""} ({search?.rerank_api_configured ? "HTTP 服务" : "词法回退"})
              </span>
              <ChevronRight size={16} style={{ color: "var(--text-muted)" }} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
