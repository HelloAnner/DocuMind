"use client";

import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, Cpu, RefreshCw, ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface ModelService {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  base_url: string;
  configured: boolean;
  status: "healthy" | "unavailable" | "disabled";
  latency_ms: number | null;
  checked_at: string;
  reason: string | null;
}

interface ModelSnapshot {
  checked_at: string;
  services: ModelService[];
}

const icons: Record<string, typeof Cpu> = {
  generation: Cpu,
  embedding: BrainCircuit,
  reranker: ScanSearch,
};

const statusLabel = {
  healthy: "在线",
  unavailable: "不可用",
  disabled: "未启用",
};

export function SystemModels() {
  const [snapshot, setSnapshot] = useState<ModelSnapshot>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await fetchJson<ModelSnapshot>("/api/system/models"));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型服务探测失败");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(console.error);
  }, [refresh]);

  const healthy = snapshot?.services.filter((service) => service.status === "healthy").length ?? 0;
  const unavailable = snapshot?.services.filter((service) => service.status === "unavailable").length ?? 0;

  return (
    <>
      <Topbar title="模型服务">
        <Button
          disabled={refreshing}
          icon={<RefreshCw size={14} />}
          onClick={() => refresh().catch(console.error)}
          variant="secondary"
        >
          {refreshing ? "探测中" : "重新探测"}
        </Button>
      </Topbar>
      <div className="dm-admin-content dm-ops-page">
        <div className="dm-stat-row">
          <StatCard label="已配置" value={String(snapshot?.services.filter((service) => service.configured).length ?? "-")} hint="运行时配置" />
          <StatCard label="在线" value={String(snapshot ? healthy : "-")} hint="实时请求探测成功" />
          <StatCard label="不可用" value={String(snapshot ? unavailable : "-")} hint="实时请求探测失败" />
        </div>
        {error ? <div className="dm-error-banner" role="alert">{error}</div> : null}

        <Panel
          className="dm-ops-panel"
          title="运行中的模型链路"
          action={<span>{snapshot ? `探测于 ${new Date(snapshot.checked_at).toLocaleString()}` : "正在探测真实服务"}</span>}
        >
          {!snapshot ? <div className="dm-empty-state">正在连接模型提供商...</div> : null}
          <div className="dm-model-service-grid">
            {snapshot?.services.map((service) => {
              const Icon = icons[service.id] ?? Cpu;
              return (
                <article className="dm-model-service-card" key={service.id}>
                  <div className="dm-model-service-head">
                    <span className="dm-model-service-icon"><Icon size={18} /></span>
                    <div>
                      <strong>{service.name}</strong>
                      <small>{service.role}</small>
                    </div>
                    <Badge tone={service.status === "healthy" ? "success" : service.status === "disabled" ? "neutral" : "danger"}>
                      {statusLabel[service.status]}
                    </Badge>
                  </div>
                  <dl>
                    <div><dt>模型</dt><dd>{service.model}</dd></div>
                    <div><dt>提供商</dt><dd>{service.provider}</dd></div>
                    <div><dt>实时延迟</dt><dd>{service.latency_ms === null ? "—" : `${service.latency_ms} ms`}</dd></div>
                    <div><dt>接口</dt><dd title={service.base_url}>{service.base_url || "未配置"}</dd></div>
                  </dl>
                  <div className={`dm-model-probe ${service.status}`}>
                    {service.reason ?? "真实接口探测成功"}
                  </div>
                </article>
              );
            })}
          </div>
        </Panel>
      </div>
    </>
  );
}
