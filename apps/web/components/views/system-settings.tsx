"use client";

import { useEffect, useMemo, useState } from "react";
import { Database, HardDrive, LockKeyhole, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { ReadonlyField } from "@/components/ui/readonly-field";
import { Topbar } from "@/components/ui/topbar";
import {
  getSystemSettings,
  updateSystemSettings,
  type EditableSystemSettings,
  type SystemSettingsSnapshot,
} from "@/lib/api";

interface SettingsForm {
  auth_token_expire_hours: string;
  object_storage_presign_expire_seconds: string;
}

function formFrom(settings: EditableSystemSettings): SettingsForm {
  return {
    auth_token_expire_hours: String(settings.auth_token_expire_hours),
    object_storage_presign_expire_seconds: String(settings.object_storage_presign_expire_seconds),
  };
}

function StatusBadge({ ready }: { ready: boolean }) {
  return <Badge tone={ready ? "success" : "danger"}>{ready ? "已连接" : "未配置"}</Badge>;
}

export function SystemSettings() {
  const [settings, setSettings] = useState<SystemSettingsSnapshot>();
  const [form, setForm] = useState<SettingsForm>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSystemSettings()
      .then((data) => {
        setSettings(data);
        setForm(formFrom(data.editable.values));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "系统设置加载失败"));
  }, []);

  const parsed = useMemo(() => {
    if (!settings || !form) return null;
    const tokenHours = Number(form.auth_token_expire_hours);
    const presignSeconds = Number(form.object_storage_presign_expire_seconds);
    const tokenLimit = settings.editable.constraints.auth_token_expire_hours;
    const presignLimit = settings.editable.constraints.object_storage_presign_expire_seconds;
    if (!Number.isInteger(tokenHours) || tokenHours < tokenLimit.min || tokenHours > tokenLimit.max) return null;
    if (!Number.isInteger(presignSeconds) || presignSeconds < presignLimit.min || presignSeconds > presignLimit.max) return null;
    return {
      auth_token_expire_hours: tokenHours,
      object_storage_presign_expire_seconds: presignSeconds,
    };
  }, [form, settings]);

  const dirty = Boolean(settings && parsed && (
    parsed.auth_token_expire_hours !== settings.editable.values.auth_token_expire_hours
    || parsed.object_storage_presign_expire_seconds
      !== settings.editable.values.object_storage_presign_expire_seconds
  ));

  const reset = () => {
    if (!settings) return;
    setForm(formFrom(settings.editable.values));
    setError("");
    setMessage("");
  };

  const save = async () => {
    if (!parsed) {
      setError("请修正输入值后再保存");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const updated = await updateSystemSettings(parsed);
      setSettings(updated);
      setForm(formFrom(updated.editable.values));
      setMessage("设置已保存并立即生效");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "系统设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Topbar title="系统设置" subtitle="可在线修改安全时效；基础设施配置保持只读，避免伪保存">
        <Badge tone="success">真实持久化</Badge>
      </Topbar>

      <div className="dm-admin-content dm-settings-page">
        {error ? <div className="dm-error-banner" role="alert">{error}</div> : null}
        {message ? <div className="dm-inline-notice" role="status">{message}</div> : null}
        {!settings || !form ? <div className="dm-empty-state">加载系统设置中...</div> : (
          <>
            <section className="dm-settings-hero">
              <div>
                <span className="dm-settings-hero-icon"><ShieldCheck size={20} /></span>
                <div>
                  <strong>运行时安全设置</strong>
                  <p>保存到 PostgreSQL，并立即作用于新会话和新生成的预览链接。</p>
                </div>
              </div>
              <div className="dm-settings-save-state">
                <span>{settings.updated_at ? `上次保存 ${new Date(settings.updated_at).toLocaleString()}` : "当前使用环境默认值"}</span>
                <Badge tone={dirty ? "warning" : "neutral"}>{dirty ? "有未保存修改" : "已保存"}</Badge>
              </div>
            </section>

            <Panel className="dm-settings-editor" title="可在线修改">
              <div className="dm-settings-field-grid">
                <label className="dm-settings-field">
                  <span>登录会话有效期</span>
                  <p>仅影响保存后签发的新 Token 与 Redis 会话；现有会话不会被强制延长或缩短。</p>
                  <div>
                    <input
                      inputMode="numeric"
                      max={settings.editable.constraints.auth_token_expire_hours.max}
                      min={settings.editable.constraints.auth_token_expire_hours.min}
                      onChange={(event) => setForm({ ...form, auth_token_expire_hours: event.target.value })}
                      type="number"
                      value={form.auth_token_expire_hours}
                    />
                    <span>小时</span>
                  </div>
                  <small>允许 {settings.editable.constraints.auth_token_expire_hours.min}–{settings.editable.constraints.auth_token_expire_hours.max} 小时</small>
                </label>

                <label className="dm-settings-field">
                  <span>文件预览链接有效期</span>
                  <p>仅影响保存后新生成的签名预览链接；已经签发的链接保持原到期时间。</p>
                  <div>
                    <input
                      inputMode="numeric"
                      max={settings.editable.constraints.object_storage_presign_expire_seconds.max}
                      min={settings.editable.constraints.object_storage_presign_expire_seconds.min}
                      onChange={(event) => setForm({ ...form, object_storage_presign_expire_seconds: event.target.value })}
                      type="number"
                      value={form.object_storage_presign_expire_seconds}
                    />
                    <span>秒</span>
                  </div>
                  <small>允许 {settings.editable.constraints.object_storage_presign_expire_seconds.min}–{settings.editable.constraints.object_storage_presign_expire_seconds.max} 秒</small>
                </label>
              </div>
              <div className="dm-settings-actions">
                <span>{parsed ? "输入有效" : "输入超出允许范围"}</span>
                <div>
                  <Button disabled={!dirty || saving} icon={<RotateCcw size={14} />} onClick={reset} variant="secondary">撤销修改</Button>
                  <Button disabled={!dirty || saving || !parsed} icon={<Save size={14} />} onClick={() => save().catch(console.error)}>
                    {saving ? "保存中" : "保存并立即生效"}
                  </Button>
                </div>
              </div>
            </Panel>

            <div className="dm-settings-columns">
              <Panel title="基础组件">
                <div className="dm-settings-service-list">
                  <div><Database size={15} /><span>PostgreSQL</span><StatusBadge ready={settings.storage.database_configured} /></div>
                  <div><Database size={15} /><span>Redis</span><StatusBadge ready={settings.storage.redis_configured} /></div>
                  <div><Database size={15} /><span>RabbitMQ</span><StatusBadge ready={settings.storage.rabbitmq_configured} /></div>
                  <div><Database size={15} /><span>Elasticsearch</span><StatusBadge ready={settings.storage.elasticsearch_configured} /></div>
                  <div><HardDrive size={15} /><span>{settings.storage.object_storage_provider} / {settings.storage.object_storage_bucket}</span><StatusBadge ready={settings.storage.object_storage_endpoint_configured} /></div>
                </div>
              </Panel>

              <Panel title="认证与入口">
                <div className="dm-config-stack">
                  <ReadonlyField label="登录模式" value={settings.auth.login_mode} />
                  <ReadonlyField label="本地登录" value={settings.auth.local_login_enabled ? "启用" : "关闭"} />
                  <ReadonlyField label="门户登录" value={settings.auth.portal_login_enabled ? "启用" : "关闭"} />
                  <ReadonlyField label="监听地址" value={`${settings.service.host}:${settings.service.port}`} code copyable />
                  <ReadonlyField label="访问前缀" value={settings.service.base_path} code copyable />
                </div>
              </Panel>
            </div>

            <Panel
              title="部署配置"
              action={<Badge tone="warning"><LockKeyhole size={11} /> 重启后生效</Badge>}
            >
              <p className="dm-settings-readonly-note">
                数据库、缓存、对象存储、认证模式与部署路径来自服务器环境变量。此页不会提供无法真正生效的编辑框。
              </p>
              <div className="dm-settings-path-grid">
                <ReadonlyField label="运行环境" value={settings.environment} />
                <ReadonlyField label="当前版本" value={settings.deployment.current} code copyable />
                <ReadonlyField label="配置文件" value={settings.deployment.env_file} code copyable />
                <ReadonlyField label="日志文件" value={settings.deployment.log_file} code copyable />
              </div>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
