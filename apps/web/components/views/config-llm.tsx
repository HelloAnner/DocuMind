"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Topbar } from "@/components/ui/topbar";

const providers = [
  { name: "DashScope", model: "qwen-turbo，性价比高", active: true },
  { name: "OpenAI", model: "gpt-4o / gpt-4o-mini", active: false },
  { name: "DeepSeek", model: "deepseek-chat，推理能力强", active: false },
];

export function ConfigLlm() {
  const [activeProvider, setActiveProvider] = useState("DashScope");

  return (
    <>
      <Topbar title="LLM 服务商">
        <Button>保存</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>配置大语言模型提供商，用于查询改写与答案生成。</p>

          <div className="dm-provider-grid">
            {providers.map((provider) => (
              <button
                key={provider.name}
                className={`dm-provider-card ${activeProvider === provider.name ? "active" : ""}`}
                onClick={() => setActiveProvider(provider.name)}
                type="button"
              >
                <strong>{provider.name}</strong>
                <small>{provider.model}</small>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="dm-field-row">
              <span>API 地址</span>
              <div className="dm-field-suffix">
                <input defaultValue="https://dashscope.aliyuncs.com/compatible-mode/v1" style={{ minWidth: 320 }} />
              </div>
            </div>
            <div className="dm-field-row">
              <span>API Key</span>
              <div className="dm-field-suffix">
                <input defaultValue="sk-••••••••••••••••" type="password" />
              </div>
            </div>
            <div className="dm-field-row">
              <span>模型名称</span>
              <div className="dm-field-suffix">
                <input defaultValue="qwen-turbo" />
              </div>
            </div>
          </div>

          <div className="dm-config-section">
            <div className="dm-config-section-title">高级参数</div>
            <div className="dm-range-field">
              <div>
                <span>Temperature</span>
                <strong>0.7</strong>
              </div>
              <input defaultValue={70} max={100} min={0} type="range" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
