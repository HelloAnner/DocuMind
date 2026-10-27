"use client";

import { useEffect, useRef } from "react";
import { mountRbacPanel, type RbacAdapter, type RbacPanelHandle } from "@/lib/rbac/panel";

/** React 只是宿主：权限面板本身是四端共用的无框架组件。 */
export function RbacPanelHost({ adapter, readOnly = false }: { adapter: RbacAdapter; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<RbacPanelHandle | null>(null);

  useEffect(() => {
    if (!host.current) return;
    panel.current = mountRbacPanel(host.current, { adapter, readOnly });
    return () => {
      panel.current?.destroy();
      panel.current = null;
    };
    // adapter 只有稳定函数；页面切换系统时由 key 强制重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} style={{ height: "100%", minHeight: 560 }} />;
}
