"use client";

import Link from "next/link";
import { ChevronUp, LogOut, Settings, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { isSuperAdminRole, isTenantAdminRole } from "@/lib/auth";
import styles from "./user-account-menu.module.css";

export function UserAccountMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
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

  if (!me) return null;
  const initials = (me.user.name || me.user.login_id).trim().slice(0, 1).toUpperCase();

  return (
    <div className={`${styles.root} dm-user-menu-root`} ref={rootRef}>
      {open ? (
        <div className={`${styles.menu} dm-user-menu-popover`} role="menu">
          <Link href="/account" onClick={() => setOpen(false)}>
            <UserRound size={15} />
            账号与个人资料
          </Link>
          {managementHref ? (
            <Link href={managementHref} onClick={() => setOpen(false)}>
              <Settings size={15} />
              {isSuperAdmin ? "平台管理后台" : "租户管理后台"}
            </Link>
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
          {me.user.avatar_url ? <img alt="" src={me.user.avatar_url} /> : initials}
        </span>
        <span className={`${styles.identity} dm-user-menu-identity`}>
          <strong>{me.user.name || me.user.login_id}</strong>
          <span>{isSuperAdmin ? "超级管理员" : isTenantAdmin ? "租户管理员" : me.tenant.name}</span>
        </span>
        <ChevronUp size={14} />
      </button>
    </div>
  );
}
