"use client";
import type { FormEvent } from "react";

import Link from "next/link";
import { ChevronUp, LogOut, Settings, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { isSuperAdminRole, isTenantAdminRole, updateAccountProfile } from "@/lib/auth";
import styles from "./user-account-menu.module.css";

export function UserAccountMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
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
          <button onClick={() => { setOpen(false); setProfileOpen(true); }} type="button">
            <UserRound size={15} />
            账号与个人资料
          </button>
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
      {profileOpen ? <ProfileModal onClose={() => setProfileOpen(false)} /> : null}
    </div>
  );
}

function ProfileModal({ onClose }: { onClose: () => void }) {
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.user.name || me?.user.login_id || "");
  const [avatarUrl, setAvatarUrl] = useState(me?.user.avatar_url || "");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose, saving]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("展示名称不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await updateAccountProfile(name, avatarUrl);
      await refresh();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const initials = (name || me?.user.login_id || "U").trim().slice(0, 1).toUpperCase();
  return (
    <div className="dm-modal-overlay" onMouseDown={() => !saving && onClose()}>
      <form
        aria-labelledby="account-profile-modal-title"
        aria-modal="true"
        className={`dm-modal ${styles.profileModal}`}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={save}
        role="dialog"
      >
        <div className="dm-modal-head">
          <div>
            <h2 id="account-profile-modal-title">个人配置</h2>
            <p>临时修改展示名称和头像。</p>
          </div>
          <button aria-label="关闭" className="dm-icon-button" disabled={saving} onClick={onClose} type="button"><X size={17} /></button>
        </div>
        <div className={styles.profileForm}>
          <div className={styles.profilePreview}>
            <span className={styles.avatarLarge}>
              {avatarUrl && !avatarFailed
                ? <img alt="" onError={() => setAvatarFailed(true)} src={avatarUrl} />
                : initials}
            </span>
            <span>
              <strong>{name.trim() || me?.user.login_id}</strong>
              <small>头像会同步显示在账号菜单和对话中</small>
            </span>
          </div>
          <label className={styles.field}>
            <span>展示名称</span>
            <input autoComplete="name" maxLength={128} onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <label className={styles.field}>
            <span>头像地址</span>
            <input maxLength={2048} onChange={(event) => { setAvatarUrl(event.target.value); setAvatarFailed(false); }} placeholder="https://…" type="url" value={avatarUrl} />
          </label>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className="dm-modal-actions">
            <button className={styles.secondary} disabled={saving} onClick={onClose} type="button">取消</button>
            <button className={styles.primary} disabled={saving} type="submit">{saving ? "保存中…" : "保存"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
