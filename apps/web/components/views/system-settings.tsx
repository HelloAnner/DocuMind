"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { ReadonlyField } from "@/components/ui/readonly-field";
import { Topbar } from "@/components/ui/topbar";
import { getSystemSettings, type SystemSettingsSnapshot } from "@/lib/api";

function ConfiguredBadge({ configured }: { configured: boolean }) {
  return (
    <Badge tone={configured ? "success" : "warning"}>
      {configured ? "已配置" : "未配置"}
    </Badge>
  );
}

function AuthBadge({ enabled }: { enabled: boolean }) {
  return <Badge tone={enabled ? "success" : "warning"}>{enabled ? "是" : "否"}</Badge>;
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
      <Topbar title="系统设置" subtitle="只读运行配置，变更需更新服务器环境并重新部署">
        <Badge tone="neutral">只读</Badge>
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
                  <ReadonlyField label="运行环境" value={settings.environment} />
                  <ReadonlyField
                    label="监听地址"
                    value={`${settings.service.host}:${settings.service.port}`}
                    code
                    copyable
                  />
                  <ReadonlyField label="访问前缀" value={settings.service.base_path} code copyable />
                  <ReadonlyField label="健康检查" value={settings.service.health_path} code />
                </div>
              </Panel>

              <Panel title="认证">
                <div className="dm-config-stack">
                  <ReadonlyField label="登录模式" value={settings.auth.login_mode} />
                  <ReadonlyField label="会话有效期" value={`${settings.auth.token_expire_hours} 小时`} />
                  <ReadonlyField
                    label="本地登录"
                    value={<AuthBadge enabled={settings.auth.local_login_enabled} />}
                  />
                  <ReadonlyField
                    label="门户登录"
                    value={<AuthBadge enabled={settings.auth.portal_login_enabled} />}
                  />
                  <ReadonlyField
                    label="门户换票接口"
                    value={settings.auth.portal_exchange_endpoint}
                    code
                    copyable
                  />
                </div>
              </Panel>

              <Panel title="基础组件">
                <div className="dm-config-stack">
                  <ReadonlyField
                    label="PostgreSQL"
                    value={<ConfiguredBadge configured={settings.storage.database_configured} />}
                  />
                  <ReadonlyField
                    label="Redis"
                    value={<ConfiguredBadge configured={settings.storage.redis_configured} />}
                  />
                  <ReadonlyField
                    label="RabbitMQ"
                    value={<ConfiguredBadge configured={settings.storage.rabbitmq_configured} />}
                  />
                  <ReadonlyField
                    label="Elasticsearch"
                    value={<ConfiguredBadge configured={settings.storage.elasticsearch_configured} />}
                  />
                  <ReadonlyField
                    label="对象存储 endpoint"
                    value={<ConfiguredBadge configured={settings.storage.object_storage_endpoint_configured} />}
                  />
                  <ReadonlyField
                    label="对象存储"
                    value={`${settings.storage.object_storage_provider} / ${settings.storage.object_storage_bucket}`}
                    code
                    copyable
                  />
                  <ReadonlyField
                    label="Presign 有效期"
                    value={`${settings.storage.object_storage_presign_expire_seconds} 秒`}
                  />
                </div>
              </Panel>

              <Panel title="部署路径">
                <div className="dm-config-stack">
                  <ReadonlyField label="主机别名" value={settings.deployment.host_alias} />
                  <ReadonlyField label="部署根目录" value={settings.deployment.root} code copyable />
                  <ReadonlyField label="当前版本" value={settings.deployment.current} code copyable />
                  <ReadonlyField label="版本目录" value={settings.deployment.releases} code copyable />
                  <ReadonlyField label="共享目录" value={settings.deployment.shared} code copyable />
                  <ReadonlyField label=".env" value={settings.deployment.env_file} code copyable />
                  <ReadonlyField label="日志文件" value={settings.deployment.log_file} code copyable />
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
