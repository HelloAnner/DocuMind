"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Power, RefreshCw, ShieldOff } from "lucide-react";
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

const scopeOptions = [
  { value: "chat:write", label: "发起问答" },
  { value: "conversations:read", label: "读取会话" },
  { value: "conversations:write", label: "管理会话" },
  { value: "knowledge_bases:read", label: "读取知识库" },
];

export function AdminApiClients() {
  const [clients, setClients] = useState<ApiClientSummary[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kbIds, setKbIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState(scopeOptions.map((scope) => scope.value));
  const [expires, setExpires] = useState(90);
  const [rateLimit, setRateLimit] = useState(60);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"endpoint" | "token" | "quick" | null>(null);

  const reload = async () => {
    const [nextClients, nextKbs] = await Promise.all([listApiClients(), listAdminKnowledgeBases()]);
    setClients(nextClients);
    setKnowledgeBases(nextKbs);
  };

  useEffect(() => {
    reload().catch((cause) => setError(cause instanceof Error ? cause.message : "MCP 接入数据加载失败"));
  }, []);

  const create = async () => {
    if (!name.trim() || !kbIds.length || !scopes.length) {
      setError("请输入应用名称，并至少选择一个知识库和一项能力");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createApiClient({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        kb_ids: kbIds,
        scopes,
        expires_in_days: expires,
        rate_limit_per_minute: rateLimit,
      });
      setSecret(result.token);
      setName("");
      setDescription("");
      setKbIds([]);
      setScopes(scopeOptions.map((scope) => scope.value));
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

  const copy = async (value: string, target: "endpoint" | "token" | "quick") => {
    await copyToClipboard(value);
    setCopied(target);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <>
      <Topbar
        title="MCP 接入"
        subtitle="为外部 AI 应用创建独立身份，并限制其知识库与会话权限"
      />
      <div className="dm-admin-content dm-settings-page">
        <div className="dm-settings-layout">
          <Panel className="dm-settings-panel" title="服务地址">
            <p className="dm-form-note">
              使用 Streamable HTTP 连接。Token 同时绑定当前租户、服务身份、知识库范围与会话。
            </p>
            <div className="dm-mcp-endpoint-row">
              <code>/documind/mcp</code>
              <Button
                icon={copied === "endpoint" ? <Check size={14} /> : <Copy size={14} />}
                onClick={() => copy(`${window.location.origin}/documind/mcp`, "endpoint")}
              >
                {copied === "endpoint" ? "已复制" : "复制地址"}
              </Button>
            </div>
          </Panel>

          {secret ? (
            <Panel className="dm-settings-panel dm-mcp-secret-panel" title="保存 MCP Token">
              <p className="dm-form-note">
                Token 仅显示一次，请立即保存到 MCP 客户端的安全密钥存储中。
              </p>
              <code className="dm-mcp-secret">{secret}</code>
              <div className="dm-mcp-token-actions">
                <Button icon={copied === "token" ? <Check size={14} /> : <Copy size={14} />} onClick={() => copy(secret, "token")}>
                  {copied === "token" ? "已复制" : "复制 Token"}
                </Button>
                <Button variant="secondary" icon={copied === "quick" ? <Check size={14} /> : <Copy size={14} />} onClick={() => copy(`请在当前 AI 客户端中添加并验证名为 DocuMind 的 MCP 服务：使用 Streamable HTTP，地址 ${window.location.origin}/documind/mcp，认证请求头为 Authorization: Bearer ${secret}。`, "quick")}>
                  {copied === "quick" ? "已复制" : "复制快速配置"}
                </Button>
                <Button variant="ghost" onClick={() => setSecret(null)}>我已保存</Button>
              </div>
              <p className="dm-form-note">快速配置包含完整 Token，请只发送给可信的 AI 客户端。</p>
            </Panel>
          ) : null}

          <Panel className="dm-settings-panel" title="创建 MCP 应用">
            <form
              className="dm-mcp-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                create().catch(console.error);
              }}
            >
              <div className="dm-mcp-form-grid">
                <label className="dm-form-field">
                  <span>应用名称</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 CRM 客服机器人" />
                </label>
                <label className="dm-form-field">
                  <span>说明</span>
                  <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="接入用途" />
                </label>
                <label className="dm-form-field">
                  <span>有效期</span>
                  <select value={expires} onChange={(event) => setExpires(Number(event.target.value))}>
                    <option value={30}>30 天</option>
                    <option value={90}>90 天</option>
                    <option value={180}>180 天</option>
                    <option value={365}>365 天</option>
                  </select>
                </label>
                <label className="dm-form-field">
                  <span>每分钟限额</span>
                  <input type="number" min={1} max={10000} value={rateLimit} onChange={(event) => setRateLimit(Number(event.target.value))} />
                </label>
              </div>

              <fieldset className="dm-mcp-choice-section">
                <legend>授权知识库</legend>
                <div className="dm-mcp-choice-grid">
                  {knowledgeBases.map((kb) => (
                    <label className="dm-mcp-choice" key={kb.id}>
                      <input
                        type="checkbox"
                        checked={kbIds.includes(kb.id)}
                        onChange={(event) => setKbIds((current) => event.target.checked ? [...current, kb.id] : current.filter((id) => id !== kb.id))}
                      />
                      <span>{kb.name}</span>
                    </label>
                  ))}
                  {knowledgeBases.length === 0 ? <span className="dm-form-note">暂无可授权知识库</span> : null}
                </div>
              </fieldset>

              <fieldset className="dm-mcp-choice-section">
                <legend>允许能力</legend>
                <div className="dm-mcp-choice-grid">
                  {scopeOptions.map((scope) => (
                    <label className="dm-mcp-choice" key={scope.value}>
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope.value)}
                        onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope.value] : current.filter((value) => value !== scope.value))}
                      />
                      <span>{scope.label}</span>
                      <code>{scope.value}</code>
                    </label>
                  ))}
                </div>
              </fieldset>

              {error ? <div className="dm-form-note" style={{ color: "var(--color-error)" }}>{error}</div> : null}
              <div className="dm-mcp-create-actions">
                <Button type="submit" icon={<KeyRound size={14} />} disabled={busy}>
                  创建并生成 Token
                </Button>
              </div>
            </form>
          </Panel>

          <Panel className="dm-settings-panel" title="MCP 应用">
            {clients.length === 0 ? <div className="dm-settings-empty">尚未创建 MCP 应用</div> : null}
            <div className="dm-mcp-client-list">
              {clients.map((client) => (
                <article className="dm-mcp-client" key={client.id}>
                  <div className="dm-mcp-client-head">
                    <div>
                      <div className="dm-mcp-client-title"><strong>{client.name}</strong><Badge>{client.status === "active" ? "启用" : "停用"}</Badge></div>
                      <p>{client.description || "无说明"} · {client.kb_ids.length} 个知识库 · {client.rate_limit_per_minute} 次/分钟</p>
                      <code>{client.scopes.join(" · ")}</code>
                    </div>
                    <div className="dm-mcp-client-actions">
                      <Button variant="secondary" icon={<RefreshCw size={14} />} disabled={busy} onClick={() => rotate(client.id).catch(console.error)}>新 Token</Button>
                      <Button variant="secondary" icon={<Power size={14} />} disabled={busy} onClick={() => toggle(client).catch(console.error)}>{client.status === "active" ? "停用" : "启用"}</Button>
                    </div>
                  </div>
                  {client.tokens.map((token) => (
                    <div className="dm-mcp-token-row" key={token.id}>
                      <code>{token.token_prefix}…</code>
                      <span>{token.status} · 到期 {new Date(token.expires_at).toLocaleDateString()} · 最近使用 {token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "从未"}</span>
                      {token.status === "active" ? <Button variant="secondary" icon={<ShieldOff size={14} />} disabled={busy} onClick={() => revoke(client.id, token.id).catch(console.error)}>吊销</Button> : <span />}
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
