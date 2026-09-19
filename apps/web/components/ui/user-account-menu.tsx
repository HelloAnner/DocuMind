"use client";

import { Bell, Building2, LogOut, Moon, Settings, Sun, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/components/providers/auth-provider";
import { isSuperAdminRole, isTenantAdminRole } from "@/lib/auth";
import styles from "./user-account-menu.module.css";

const UPDATES = [
  { title: "侧边栏焕新", detail: "工作空间、对话搜索和排序入口已重新整理。", date: "刚刚" },
  { title: "探索中心上线", detail: "帮助文档与使用建议现已集中到探索入口。", date: "今天" },
  { title: "个人资料同步", detail: "头像和展示名称会同步显示在账号菜单与对话中。", date: "近期" },
];

export function UserAccountMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
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
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setUpdatesOpen(false);
      }
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
      {updatesOpen ? (
        <section aria-label="产品更新" className={styles.updates}>
          <header>
            <strong>产品更新</strong>
            <span>DocuMind 的近期变化</span>
          </header>
          {UPDATES.map((update) => (
            <article key={update.title}>
              <span className={styles.updateDot} />
              <div>
                <strong>{update.title}</strong>
                <p>{update.detail}</p>
                <time>{update.date}</time>
              </div>
            </article>
          ))}
        </section>
      ) : null}
      <div className={`${styles.footerRow} dm-user-footer-row`}>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          className={`${styles.trigger} dm-user-menu-trigger`}
          onClick={() => {
            setUpdatesOpen(false);
            setOpen((value) => !value);
          }}
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
        </button>
        <button
          aria-expanded={updatesOpen}
          aria-label="产品更新"
          className={`${styles.bell} dm-user-update-bell`}
          onClick={() => {
            setOpen(false);
            setUpdatesOpen((value) => !value);
          }}
          type="button"
        >
          <Bell size={18} />
          <span />
        </button>
      </div>
      {windowPage ? <AppWindow {...windowPage} onClose={() => setWindowPage(null)} /> : null}
    </div>
  );
}

export function AppWindow({ href, title, onClose }: { href: string; title: string; onClose: () => void }) {
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
