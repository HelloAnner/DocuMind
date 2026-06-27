"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface ModelService {
  id: string;
  name: string;
  model: string;
  base_url: string;
  api_key_tail: string;
  status: string;
  throughput: string;
  latency: string;
}

export function SystemModels() {
  const [models, setModels] = useState<ModelService[]>([]);

  useEffect(() => {
    fetchJson<ModelService[]>("/api/system/models").then(setModels).catch(console.error);
  }, []);

  return (
    <>
      <Topbar title="模型服务">
        <Badge tone="neutral">只读配置</Badge>
      </Topbar>
      <div className="dm-admin-content">
        <Panel title="Providers">
          {models.map((m) => (
            <div className="dm-model-row" key={m.id}>
              <div className="dm-model-name">
                <strong>{m.name}</strong>
                <small>{m.model}</small>
              </div>
              <div className="dm-model-config">
                <span>{m.base_url}</span>
                <small>sk-······{m.api_key_tail}</small>
              </div>
              <Badge tone={m.status === "healthy" ? "success" : "warning"}>{m.status}</Badge>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{m.throughput}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{m.latency}</span>
              <div className="dm-row-actions">
                <Badge tone="neutral">env</Badge>
              </div>
            </div>
          ))}
          {models.length === 0 ? <div className="dm-empty-state">暂无模型配置</div> : null}
        </Panel>
      </div>
    </>
  );
}
