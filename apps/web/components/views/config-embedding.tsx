"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ReadonlyField } from "@/components/ui/readonly-field";
import { Topbar } from "@/components/ui/topbar";
import { getAdminRuntimeConfig, type AdminRuntimeConfig } from "@/lib/api";

export function ConfigEmbedding() {
  const [config, setConfig] = useState<AdminRuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminRuntimeConfig()
      .then(setConfig)
      .catch((err) => setError(err instanceof Error ? err.message : "配置加载失败"));
  }, []);

  const embedding = config?.embedding;

  return (
    <>
      <Topbar title="向量化模型">
        <Badge tone={embedding?.enabled ? "success" : "warning"}>
          {embedding?.enabled ? "已启用" : "未启用"}
        </Badge>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>当前模型与索引配置来自服务器环境变量，模型变更需重建索引。</p>
          {error ? <p className="dm-form-note" style={{ color: "var(--color-error)" }}>{error}</p> : null}
          {!config && !error ? <div className="dm-empty-state">加载向量化配置中...</div> : null}

          <div className="dm-model-list">
            {embedding ? (
              <button
                className="dm-model-card selected"
                disabled
                type="button"
              >
                <span className="dm-model-radio checked">
                  <Check size={11} strokeWidth={3} />
                </span>
                <span>
                  <strong>{embedding.model}</strong>
                  <small>{embedding.base_url}</small>
                </span>
                <em>{embedding.api_key_configured ? "API key 已配置" : "API key 未配置"}</em>
              </button>
            ) : null}
          </div>

          <div className="dm-config-section">
            <div className="dm-config-section-title">运行参数</div>
            <ReadonlyField label="批处理大小" value={String(embedding?.batch_size ?? "")} />
            <ReadonlyField label="索引名称" value={embedding?.index_name ?? ""} code />
            <ReadonlyField label="查询别名" value={embedding?.index_alias ?? ""} code />
          </div>
        </div>
      </div>
    </>
  );
}
