"use client";

import { Bell, Building2, CheckCheck, Compass, Heart, LogOut, MessageSquare, Moon, Settings, Sparkles, Sun, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/components/providers/auth-provider";
import { isSuperAdminRole, isTenantAdminRole } from "@/lib/auth";
import styles from "./user-account-menu.module.css";

const UPDATES = [
  { id: "sidebar", title: "DocuMind 侧边栏全新升级", detail: "工作空间切换、对话搜索和排序入口已重新整理。", date: "刚刚" },
  { id: "explore", title: "探索中心上线", detail: "帮助文档与使用建议现已集中到探索入口。", date: "今天" },
  { id: "profile", title: "个人资料同步优化", detail: "头像和展示名称会同步显示在账号菜单与对话中。", date: "3 天前" },
];

export function UserAccountMenu({ onExplore }: { onExplore: () => void }) {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [updatesTab, setUpdatesTab] = useState<"messages" | "following">("messages");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [readUpdates, setReadUpdates] = useState<Set<string>>(new Set());
  const [windowPage, setWindowPage] = useState<{ href: string; title: string } | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const updatesRef = useRef<HTMLElement>(null);
  const [updatesLeft, setUpdatesLeft] = useState(312);
  const rootRef = useRef<HTMLDivElement>(null);
  const roles = me?.roles ?? [];
  const isSuperAdmin = me?.scope === "platform" && isSuperAdminRole(roles);
  const isTenantAdmin = !isSuperAdmin && isTenantAdminRole(roles);
  const managementHref = isSuperAdmin ? "/system" : isTenantAdmin ? "/admin" : null;

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (
        !rootRef.current?.contains(event.target as Node) &&
        !updatesRef.current?.contains(event.target as Node)
      ) {
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
  const visibleUpdates = unreadOnly
    ? UPDATES.filter((update) => !readUpdates.has(update.id))
    : UPDATES;
  const hasUnreadUpdates = UPDATES.some((update) => !readUpdates.has(update.id));

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
      {updatesOpen && typeof document !== "undefined" ? createPortal(
        <section
          aria-label="产品更新"
          className={styles.updates}
          ref={updatesRef}
          style={{ "--updates-left": `${updatesLeft}px` } as CSSProperties}
        >
          <nav className={styles.updateTabs}>
            <span className={styles.whatsNew}>What&apos;s New</span>
            <button
              className={updatesTab === "messages" ? styles.updateTabActive : ""}
              onClick={() => setUpdatesTab("messages")}
              type="button"
            >
              <MessageSquare size={18} /> 消息通知
            </button>
            <button
              className={updatesTab === "following" ? styles.updateTabActive : ""}
              onClick={() => setUpdatesTab("following")}
              type="button"
            >
              <Heart size={18} /> 关注动态
            </button>
          </nav>
          {updatesTab === "messages" ? (
            <>
              <div className={styles.updateFilters}>
                <div>
                  <button className={!unreadOnly ? styles.filterActive : ""} onClick={() => setUnreadOnly(false)} type="button">全部</button>
                  <button className={unreadOnly ? styles.filterActive : ""} onClick={() => setUnreadOnly(true)} type="button">未读</button>
                </div>
                <button aria-label="全部标为已读" onClick={() => setReadUpdates(new Set(UPDATES.map((update) => update.id)))} title="全部标为已读" type="button">
                  <CheckCheck size={18} />
                </button>
              </div>
              <div className={styles.updateList}>
                {visibleUpdates.map((update) => (
                  <button
                    className={styles.updateItem}
                    key={update.id}
                    onClick={() => setReadUpdates((current) => new Set(current).add(update.id))}
                    type="button"
                  >
                    <div className={styles.updateMeta}>
                      <span><Sparkles size={13} /> 产品更新</span>
                      <time>{update.date}</time>
                    </div>
                    <strong>{update.title}</strong>
                    <p>{update.detail}</p>
                    {!readUpdates.has(update.id) ? <i aria-label="未读" /> : null}
                  </button>
                ))}
                {visibleUpdates.length === 0 ? <p className={styles.updateEmpty}>暂无未读消息</p> : null}
              </div>
            </>
          ) : (
            <div className={styles.updateEmptyState}>
              <Heart size={28} />
              <strong>暂无关注动态</strong>
              <span>关注的内容有更新时会显示在这里</span>
            </div>
          )}
        </section>,
        document.body,
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
          aria-label="探索"
          className={`${styles.bell} dm-user-explore`}
          onClick={() => {
            setOpen(false);
            setUpdatesOpen(false);
            onExplore();
          }}
          title="探索"
          type="button"
        >
          <Compass size={18} />
        </button>
        <button
          aria-expanded={updatesOpen}
          aria-label="产品更新"
          className={`${styles.bell} dm-user-update-bell`}
          onClick={(event) => {
            const sidebarRight = event.currentTarget.closest("aside")?.getBoundingClientRect().right ?? 288;
            const panelWidth = Math.min(520, window.innerWidth - 20);
            setUpdatesLeft(Math.max(10, Math.min(sidebarRight + 16, window.innerWidth - panelWidth - 10)));
            setOpen(false);
            setUpdatesOpen((value) => !value);
          }}
          type="button"
        >
          <Bell size={18} />
          {hasUnreadUpdates ? <span /> : null}
        </button>
      </div>
      {windowPage ? <AppWindow {...windowPage} onClose={() => setWindowPage(null)} /> : null}
    </div>
  );
}

export function AppWindow({ href, title, onClose }: { href: string; title: string; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const requestClose = useCallback(() => {
    const frame = frameRef.current?.contentWindow;
    if (frame && !frame.dispatchEvent(new Event("documind:before-close", { cancelable: true }))) return;
    onClose();
  }, [onClose]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [requestClose]);

  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (typeof document === "undefined") return null;


  return createPortal(
    <div className={styles.windowOverlay}>
      <button aria-label={`关闭${title}`} className={styles.windowBackdrop} onClick={requestClose} type="button" />
      <section aria-label={title} aria-modal="true" className={styles.appWindow} role="dialog">
        <iframe
          ref={frameRef}
          className={styles.windowFrame}
          src={`${basePath}${href}`}
          title={title}
        />
        <button aria-label={`关闭${title}`} className={styles.windowClose} onClick={requestClose} type="button">
          <X size={18} />
        </button>
      </section>
    </div>,
    document.body,
  );
}
