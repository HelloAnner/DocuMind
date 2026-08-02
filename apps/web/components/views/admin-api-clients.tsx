"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Power, RefreshCw, ShieldOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Topbar } from "@/components/ui/topbar";
import { copyToClipboard } from "@/lib/clipboard";
import {
  createApiClient,
  createApiClientToken,
  listAdminKnowledgeBases,
  listApiClients,
  revokeApiClientToken,
  updateApiClientStatus,
  type ApiClientSummary,
  type KnowledgeBase,
} from "@/lib/api";

export function AdminApiClients() {
  const [clients, setClients] = useState<ApiClientSummary[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kbIds, setKbIds] = useState<string[]>([]);
  const [expires, setExpires] = useState(90);
  const [rateLimit, setRateLimit] = useState(60);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const [nextClients, nextKbs] = await Promise.all([listApiClients(), listAdminKnowledgeBases()]);
    setClients(nextClients);
    setKnowledgeBases(nextKbs);
  };

  useEffect(() => {
    reload().catch((cause) => setError(cause instanceof Error ? cause.message : "API 接入数据加载失败"));
  }, []);

  const create = async () => {
    if (!name.trim() || !kbIds.length) {
      setError("请输入应用名称并至少选择一个知识库");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createApiClient({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        kb_ids: kbIds,
        expires_in_days: expires,
        rate_limit_per_minute: rateLimit,
      });
      setSecret(result.token);
      setName("");
      setDescription("");
      setKbIds([]);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (clientId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await createApiClientToken(clientId, expires);
      setSecret(result.secret);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Token 创建失败");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (clientId: string, tokenId: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeApiClientToken(clientId, tokenId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Token 吊销失败");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (client: ApiClientSummary) => {
    setBusy(true);
    setError(null);
    try {
      await updateApiClientStatus(client.id, client.status === "active" ? "disabled" : "active");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "状态更新失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Topbar title="API 接入" />
      <div className="dm-admin-content">
        {secret ? (
          <Panel title="保存 API Token">
            <div className="dm-form-note" style={{ color: "var(--color-warning)", marginBottom: 12 }}>
              Token 仅显示一次。请立即复制到外部系统的安全密钥存储中。
            </div>
            <div className="dm-permission-form">
              <code style={{ overflowWrap: "anywhere", flex: 1 }}>{secret}</code>
              <Button icon={<Copy size={14} />} onClick={() => copyToClipboard(secret)}>复制</Button>
              <Button variant="secondary" onClick={() => setSecret(null)}>我已保存</Button>
            </div>
          </Panel>
        ) : null}

        <Panel title="创建外部应用">
          <div className="dm-permission-form">
            <label className="dm-form-field"><span>应用名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 CRM 客服机器人" /></label>
            <label className="dm-form-field"><span>说明</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="接入用途" /></label>
            <label className="dm-form-field"><span>有效期</span><select value={expires} onChange={(event) => setExpires(Number(event.target.value))}><option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>365 天</option></select></label>
            <label className="dm-form-field"><span>每分钟限额</span><input type="number" min={1} max={10000} value={rateLimit} onChange={(event) => setRateLimit(Number(event.target.value))} /></label>
          </div>
          <div className="dm-form-note" style={{ margin: "14px 0 8px" }}>授权知识库</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {knowledgeBases.map((kb) => <label key={kb.id} style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={kbIds.includes(kb.id)} onChange={(event) => setKbIds((current) => event.target.checked ? [...current, kb.id] : current.filter((id) => id !== kb.id))} />{kb.name}</label>)}
          </div>
          {error ? <div className="dm-form-note" style={{ color: "var(--color-error)", marginTop: 12 }}>{error}</div> : null}
          <div style={{ marginTop: 16 }}><Button icon={<KeyRound size={14} />} disabled={busy} onClick={() => create().catch(console.error)}>创建并生成 Token</Button></div>
        </Panel>

        <Panel title="外部应用">
          {clients.length === 0 ? <div className="dm-empty-state">尚未创建外部应用</div> : null}
          {clients.map((client) => (
            <div key={client.id} style={{ borderBottom: "1px solid var(--border-subtle)", padding: "16px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div><strong>{client.name}</strong> <Badge>{client.status === "active" ? "启用" : "停用"}</Badge><div className="dm-form-note">{client.description || "无说明"} · {client.kb_ids.length} 个知识库 · {client.rate_limit_per_minute} 次/分钟</div></div>
                <div style={{ display: "flex", gap: 8 }}><Button variant="secondary" icon={<RefreshCw size={14} />} disabled={busy} onClick={() => rotate(client.id).catch(console.error)}>新 Token</Button><Button variant="secondary" icon={<Power size={14} />} disabled={busy} onClick={() => toggle(client).catch(console.error)}>{client.status === "active" ? "停用" : "启用"}</Button></div>
              </div>
              {client.tokens.map((token) => (
                <div key={token.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center", marginTop: 10 }}>
                  <code>{token.token_prefix}…</code>
                  <span className="dm-form-note">{token.status} · 到期 {new Date(token.expires_at).toLocaleDateString()} · 最近使用 {token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "从未"}</span>
                  {token.status === "active" ? <Button variant="secondary" icon={<ShieldOff size={14} />} disabled={busy} onClick={() => revoke(client.id, token.id).catch(console.error)}>吊销</Button> : <span />}
                </div>
              ))}
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
