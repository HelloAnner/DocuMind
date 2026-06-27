"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Topbar } from "@/components/ui/topbar";
import { getSystemSettings, type SystemSettingsSnapshot } from "@/lib/api";

const yesNo = (value: boolean) => (value ? "是" : "否");

function tone(value: boolean) {
  return value ? "success" : "warning";
}

export function SystemSettings() {
  const [settings, setSettings] = useState<SystemSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSystemSettings()
      .then(setSettings)
      .catch((err) => setError(err instanceof Error ? err.message : "系统设置加载失败"));
  }, []);

  return (
    <>
      <Topbar title="系统设置">
        <Badge tone="neutral">只读配置</Badge>
      </Topbar>
      <div className="dm-admin-content">
        <div className="dm-config-content">
          <p>系统设置来自远端运行环境，修改需要更新服务器配置并重新部署。</p>
          {error ? <p className="dm-form-note" style={{ color: "var(--color-error)" }}>{error}</p> : null}
          {!settings && !error ? <div className="dm-empty-state">加载系统设置中...</div> : null}

          {settings ? (
            <>
              <Panel title="运行入口">
                <div className="dm-config-stack">
                  <div className="dm-field-row">
                    <span>运行环境</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={settings.environment} />
                    </div>
                  </div>
                  <div className="dm-field-row">
                    <span>监听地址</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={`${settings.service.host}:${settings.service.port}`} />
                    </div>
                  </div>
                  <div className="dm-field-row">
                    <span>访问前缀</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={settings.service.base_path} />
                    </div>
                  </div>
                  <div className="dm-field-row">
                    <span>健康检查</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={settings.service.health_path} />
                    </div>
                  </div>
                </div>
              </Panel>

              <Panel title="认证">
                <div className="dm-config-stack">
                  <div className="dm-field-row">
                    <span>登录模式</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={settings.auth.login_mode} />
                    </div>
                  </div>
                  <div className="dm-field-row">
                    <span>会话有效期</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={settings.auth.token_expire_hours} />
                      <span style={{ color: "var(--text-muted)", fontSize: 13 }}>小时</span>
                    </div>
                  </div>
                  <div className="dm-field-row">
                    <span>本地登录</span>
                    <Badge tone={tone(settings.auth.local_login_enabled)}>{yesNo(settings.auth.local_login_enabled)}</Badge>
                  </div>
                  <div className="dm-field-row">
                    <span>门户登录</span>
                    <Badge tone={tone(settings.auth.portal_login_enabled)}>{yesNo(settings.auth.portal_login_enabled)}</Badge>
                  </div>
                  <div className="dm-field-row">
                    <span>门户换票接口</span>
                    <div className="dm-field-suffix">
                      <input readOnly style={{ minWidth: 280 }} value={settings.auth.portal_exchange_endpoint} />
                    </div>
                  </div>
                </div>
              </Panel>

              <Panel title="基础组件">
                <div className="dm-config-stack">
                  {[
                    ["PostgreSQL", settings.storage.database_configured],
                    ["Redis", settings.storage.redis_configured],
                    ["RabbitMQ", settings.storage.rabbitmq_configured],
                    ["Elasticsearch", settings.storage.elasticsearch_configured],
                    ["对象存储 endpoint", settings.storage.object_storage_endpoint_configured],
                  ].map(([label, configured]) => (
                    <div className="dm-field-row" key={label as string}>
                      <span>{label as string}</span>
                      <Badge tone={tone(Boolean(configured))}>{Boolean(configured) ? "已配置" : "未配置"}</Badge>
                    </div>
                  ))}
                  <div className="dm-field-row">
                    <span>对象存储</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={`${settings.storage.object_storage_provider}/${settings.storage.object_storage_bucket}`} />
                    </div>
                  </div>
                  <div className="dm-field-row">
                    <span>Presign 有效期</span>
                    <div className="dm-field-suffix">
                      <input readOnly value={settings.storage.object_storage_presign_expire_seconds} />
                      <span style={{ color: "var(--text-muted)", fontSize: 13 }}>秒</span>
                    </div>
                  </div>
                </div>
              </Panel>

              <Panel title="部署路径">
                <div className="dm-config-stack">
                  {[
                    ["主机别名", settings.deployment.host_alias],
                    ["部署根目录", settings.deployment.root],
                    ["当前版本", settings.deployment.current],
                    ["版本目录", settings.deployment.releases],
                    ["共享目录", settings.deployment.shared],
                    [".env", settings.deployment.env_file],
                    ["日志文件", settings.deployment.log_file],
                  ].map(([label, value]) => (
                    <div className="dm-field-row" key={label}>
                      <span>{label}</span>
                      <div className="dm-field-suffix">
                        <input readOnly style={{ minWidth: 340 }} value={value} />
                      </div>
                    </div>
                  ))}
                  <p className="dm-form-note">
                    容器：{settings.deployment.containers.join(" / ")}
                  </p>
                </div>
              </Panel>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
