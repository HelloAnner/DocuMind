"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Topbar } from "@/components/ui/topbar";

const embeddingModels = [
  { name: "bge-large-zh-v1.5", desc: "纯中文企业文档，本地部署，推荐", dim: "1024d", selected: true },
  { name: "multilingual-e5-large", desc: "中英混合文档，本地部署", dim: "1024d", selected: false },
  { name: "text2vec-large-chinese", desc: "中文通用向量化模型", dim: "1024d", selected: false },
  { name: "OpenAI text-embedding-3-large", desc: "多语言、高精度，按调用量计费", dim: "3072d", selected: false },
];

export function ConfigEmbedding() {
  const [models, setModels] = useState(embeddingModels);

  const select = (name: string) =>
    setModels((prev) => prev.map((m) => ({ ...m, selected: m.name === name })));

  return (
    <>
      <Topbar title="向量化模型">
        <Button>保存</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>选择用于将文档切片转换为向量的模型。模型变更后需要重建索引。</p>

          <div className="dm-model-list">
            {models.map((model) => (
              <button
                key={model.name}
                className={`dm-model-card ${model.selected ? "selected" : ""}`}
                onClick={() => select(model.name)}
                type="button"
              >
                <span className={`dm-model-radio ${model.selected ? "checked" : ""}`}>
                  {model.selected && <Check size={11} strokeWidth={3} />}
                </span>
                <span>
                  <strong>{model.name}</strong>
                  <small>{model.desc}</small>
                </span>
                <em>{model.dim}</em>
              </button>
            ))}
          </div>

          <div className="dm-config-section">
            <div className="dm-config-section-title">高级选项</div>
            <div className="dm-field-row">
              <span>批处理大小</span>
              <div className="dm-field-suffix">
                <input defaultValue="32" />
              </div>
            </div>
            <div className="dm-field-row">
              <span>设备</span>
              <div className="dm-field-suffix">
                <input defaultValue="CPU" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
