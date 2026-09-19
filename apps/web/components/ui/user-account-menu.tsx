"use client";

import { ChevronUp, LogOut, Settings, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/components/providers/auth-provider";
import { isSuperAdminRole, isTenantAdminRole } from "@/lib/auth";
import styles from "./user-account-menu.module.css";

export function UserAccountMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [windowPage, setWindowPage] = useState<{ href: string; title: string } | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const roles = me?.roles ?? [];
  const isSuperAdmin = me?.scope === "platform" && isSuperAdminRole(roles);
  const isTenantAdmin = !isSuperAdmin && isTenantAdminRole(roles);
  const managementHref = isSuperAdmin ? "/system" : isTenantAdmin ? "/admin" : null;

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => setAvatarFailed(false), [me?.user.avatar_url]);

  if (!me) return null;
  const initials = (me.user.name || me.user.login_id).trim().slice(0, 1).toUpperCase();

  return (
    <div className={`${styles.root} dm-user-menu-root`} ref={rootRef}>
      {open ? (
        <div className={`${styles.menu} dm-user-menu-popover`} role="menu">
          <button onClick={() => { setOpen(false); setWindowPage({ href: "/account", title: "账号与个人资料" }); }} type="button">
            <UserRound size={15} />
            账号与个人资料
          </button>
          {managementHref ? (
            <button onClick={() => { setOpen(false); setWindowPage({ href: managementHref, title: isSuperAdmin ? "平台管理后台" : "租户管理后台" }); }} type="button">
              <Settings size={15} />
              {isSuperAdmin ? "平台管理后台" : "租户管理后台"}
            </button>
          ) : null}
          <div className={styles.divider} />
          <button className={styles.danger} onClick={logout} type="button">
            <LogOut size={15} />
            退出登录
          </button>
        </div>
      ) : null}
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={`${styles.trigger} dm-user-menu-trigger`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className={`${styles.avatar} dm-user-menu-avatar`}>
          {me.user.avatar_url && !avatarFailed
            ? <img alt="" onError={() => setAvatarFailed(true)} src={me.user.avatar_url} />
            : initials}
        </span>
        <span className={`${styles.identity} dm-user-menu-identity`}>
          <strong>{me.user.name || me.user.login_id}</strong>
          <span>{isSuperAdmin ? "超级管理员" : isTenantAdmin ? "租户管理员" : me.tenant?.name ?? "未选择租户"}</span>
        </span>
        <ChevronUp size={14} />
      </button>
      {windowPage ? <AppWindow {...windowPage} onClose={() => setWindowPage(null)} /> : null}
    </div>
  );
}

function AppWindow({ href, title, onClose }: { href: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const basePath = typeof window !== "undefined" && window.location.pathname.startsWith("/documind")
    ? "/documind"
    : "";
  if (typeof document === "undefined") return null;


  return createPortal(
    <div className={styles.windowOverlay}>
      <button aria-label={`关闭${title}`} className={styles.windowBackdrop} onClick={onClose} type="button" />
      <section aria-label={title} aria-modal="true" className={styles.appWindow} role="dialog">
        <iframe
          className={styles.windowFrame}
          onLoad={(event) => {
            const doc = event.currentTarget.contentDocument;
            doc?.querySelector("aside")?.remove();
          }}
          src={`${basePath}${href}`}
          title={title}
        />
        <button aria-label={`关闭${title}`} className={styles.windowClose} onClick={onClose} type="button">
          <X size={18} />
        </button>
      </section>
    </div>,
    document.body,
  );
}
