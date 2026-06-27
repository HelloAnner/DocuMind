"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Topbar } from "@/components/ui/topbar";
import { getAdminRuntimeConfig, type AdminRuntimeConfig } from "@/lib/api";

const providers = ["DashScope", "OpenAI", "DeepSeek", "OpenAI-compatible"];

export function ConfigLlm() {
  const [config, setConfig] = useState<AdminRuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminRuntimeConfig()
      .then(setConfig)
      .catch((err) => setError(err instanceof Error ? err.message : "配置加载失败"));
  }, []);

  const llm = config?.llm;

  return (
    <>
      <Topbar title="LLM 服务商">
        <Badge tone={llm?.use_real_llm ? "success" : "warning"}>
          {llm?.use_real_llm ? "真实模型" : "模拟模式"}
        </Badge>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>当前大模型配置来自服务器环境变量，密钥只显示配置状态。</p>
          {error ? <p className="dm-form-note" style={{ color: "var(--color-error)" }}>{error}</p> : null}
          {!config && !error ? <div className="dm-empty-state">加载 LLM 配置中...</div> : null}

          <div className="dm-provider-grid">
            {providers.map((provider) => (
              <button
                key={provider}
                className={`dm-provider-card ${llm?.provider === provider ? "active" : ""}`}
                disabled
                type="button"
              >
                <strong>{provider}</strong>
                <small>{llm?.provider === provider ? llm.model : "未启用"}</small>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="dm-field-row">
              <span>API 地址</span>
              <div className="dm-field-suffix">
                <input readOnly style={{ minWidth: 320 }} value={llm?.base_url ?? ""} />
              </div>
            </div>
            <div className="dm-field-row">
              <span>API Key</span>
              <div className="dm-field-suffix">
                <input readOnly value={llm?.api_key_configured ? "已配置" : "未配置"} />
              </div>
            </div>
            <div className="dm-field-row">
              <span>模型名称</span>
              <div className="dm-field-suffix">
                <input readOnly value={llm?.model ?? ""} />
              </div>
            </div>
            <div className="dm-field-row">
              <span>查询改写模型</span>
              <div className="dm-field-suffix">
                <input readOnly value={llm?.rewrite_enabled ? llm.rewrite_model : "未启用"} />
              </div>
            </div>
          </div>

          <div className="dm-config-section">
            <div className="dm-config-section-title">高级参数</div>
            <div className="dm-range-field">
              <div>
                <span>Temperature</span>
                <strong>{llm?.temperature ?? "-"}</strong>
              </div>
              <input disabled max={100} min={0} type="range" value={Math.round((llm?.temperature ?? 0) * 100)} />
            </div>
            <div className="dm-field-row">
              <span>最大输出 tokens</span>
              <div className="dm-field-suffix">
                <input readOnly value={llm?.max_output_tokens ?? ""} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
