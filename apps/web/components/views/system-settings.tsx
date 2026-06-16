"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Topbar } from "@/components/ui/topbar";

export function SystemSettings() {
  const [registration, setRegistration] = useState(true);
  const [defaultQuota, setDefaultQuota] = useState(10000);
  const [sessionTtl, setSessionTtl] = useState(24);

  return (
    <>
      <Topbar title="系统设置" />
      <div className="dm-admin-content">
        <div className="dm-config-content">
          <Panel title="General">
            <div className="dm-config-stack">
              <label className="dm-check-row">
                <input
                  type="checkbox"
                  checked={registration}
                  onChange={(e) => setRegistration(e.target.checked)}
                />
                <span>允许管理员自助注册租户</span>
              </label>

              <div className="dm-field-row">
                <span>默认租户存储配额（GB）</span>
                <div className="dm-field-suffix">
                  <input
                    type="number"
                    value={defaultQuota}
                    onChange={(e) => setDefaultQuota(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="dm-field-row">
                <span>会话有效期（小时）</span>
                <div className="dm-field-suffix">
                  <input
                    type="number"
                    value={sessionTtl}
                    onChange={(e) => setSessionTtl(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Security">
            <div className="dm-config-stack">
              <label className="dm-check-row">
                <input type="checkbox" defaultChecked />
                <span>强制要求邀请链接过期时间</span>
              </label>
              <label className="dm-check-row">
                <input type="checkbox" />
                <span>仅允许通过 Portal SSO 登录</span>
              </label>
            </div>
          </Panel>

          <div className="dm-button-row">
            <Button>保存设置</Button>
          </div>
        </div>
      </div>
    </>
  );
}
