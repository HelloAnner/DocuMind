"use client";

import { Building2, ChevronUp, LifeBuoy, LogOut, Moon, Settings, Sun, UserRound, X } from "lucide-react";
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
  const [isDark, setIsDark] = useState(false);
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

  useEffect(() => {
    setIsDark(document.documentElement.dataset.theme === "dark");
  }, []);

  if (!me) return null;
  const displayName = me.user.name || me.user.login_id;
  const initials = displayName.trim().slice(0, 1).toUpperCase();
  const roleLabel = isSuperAdmin ? "超级管理员" : isTenantAdmin ? "企业管理员" : "成员";

  const openWindow = (href: string, title: string) => {
    setOpen(false);
    setWindowPage({ href, title });
  };

  const toggleTheme = () => {
    const next = !isDark;
    document.documentElement.dataset.theme = next ? "dark" : "light";
    localStorage.setItem("documind-theme", next ? "dark" : "light");
    setIsDark(next);
  };
  return (
    <div className={`${styles.root} dm-user-menu-root`} ref={rootRef}>
      {open ? (
        <div className={`${styles.menu} dm-user-menu-popover`} role="menu">
          <div className={styles.menuHeader}>
            <span className={styles.avatar}>
              {me.user.avatar_url && !avatarFailed
                ? <img alt="" onError={() => setAvatarFailed(true)} src={me.user.avatar_url} />
                : initials}
            </span>
            <span className={styles.menuIdentity}>
              <strong>{displayName}</strong>
              <span>{roleLabel}</span>
            </span>
          </div>
          <div className={styles.divider} />
          <button className={styles.active} onClick={() => openWindow("/account", "个人设置")} type="button">
            <UserRound size={16} />
            个人设置
          </button>
          {managementHref ? (
            <button
              onClick={() => openWindow(managementHref, isSuperAdmin ? "管理后台" : "企业控制台")}
              type="button"
            >
              {isSuperAdmin ? <Settings size={16} /> : <Building2 size={16} />}
              {isSuperAdmin ? "管理后台" : "企业控制台"}
            </button>
          ) : null}
          <button onClick={() => openWindow("/help", "帮助中心")} type="button">
            <LifeBuoy size={16} />
            帮助中心
          </button>
          <button onClick={toggleTheme} type="button">
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
            {isDark ? "切换亮色" : "切换暗色"}
          </button>
          <div className={styles.divider} />
          <button className={styles.danger} onClick={logout} type="button">
            <LogOut size={16} />
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
          <strong>{displayName}</strong>
          <span>{roleLabel}</span>
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
            doc?.querySelector(".dm-admin-sidebar-drawer")?.remove();
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
