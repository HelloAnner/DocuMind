"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
        <Button icon={<Plus size={14} />}>新增 Provider</Button>
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
                <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12 }}>编辑</button>
                <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12, color: "var(--color-error)" }}>删除</button>
              </div>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
