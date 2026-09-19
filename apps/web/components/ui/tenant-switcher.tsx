"use client";

import { Check, ChevronDown, LoaderCircle, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { switchAccountTenant, type Tenant } from "@/lib/auth";
import styles from "./tenant-switcher.module.css";
export function TenantSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { me } = useAuth();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const activeId = me?.tenant?.id ?? "";
  const tenants = useMemo(() => {
    const items = [...(me?.tenants ?? [])];
    return items.sort((left, right) => {
      if (left.id === activeId) return -1;
      if (right.id === activeId) return 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
  }, [activeId, me?.tenants]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return tenants;
    return tenants.filter((tenant) =>
      `${tenant.name} ${tenant.slug}`.toLocaleLowerCase().includes(needle)
    );
  }, [query, tenants]);
  const activeTenant = tenants.find((tenant) => tenant.id === activeId) ?? me?.tenant ?? null;

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setError("");
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  if (!me) return null;
  if (me.scope === "platform" || !activeTenant) {
    return (
      <div className={`${styles.root} ${collapsed ? styles.collapsed : ""}`}>
        <button className={styles.trigger} disabled title="平台空间" type="button">
          <span className={styles.mark}><Sparkles aria-hidden="true" size={17} /></span>
          <span className={styles.current}><strong>平台空间</strong></span>
        </button>
      </div>
    );
  }

  const choose = async (tenant: Tenant) => {
    if (tenant.id === activeId) {
      setOpen(false);
      return;
    }
    setPendingId(tenant.id);
    setError("");
    try {
      await switchAccountTenant(tenant.id);
    } catch {
      setPendingId(null);
      setError("切换失败，请重试");
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + direction + filtered.length) % Math.max(filtered.length, 1));
      return;
    }
    if (event.key === "Enter" && filtered[activeIndex]) {
      event.preventDefault();
      void choose(filtered[activeIndex]);
    }
  };

  return (
    <div className={`${styles.root} ${collapsed ? styles.collapsed : ""}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        aria-expanded={open}
        className={styles.trigger}
        onClick={() => !pendingId && setOpen((value) => !value)}
        title={activeTenant.name}
        type="button"
      >
        <span className={styles.mark}><Sparkles aria-hidden="true" size={17} /></span>
        <span className={styles.current}>
          <strong>{activeTenant.name}</strong>
        </span>
        {pendingId ? <LoaderCircle className={styles.spin} size={16} /> : <ChevronDown className={open ? styles.chevronOpen : ""} size={16} />}
      </button>

      {open ? (
        <div className={styles.popover}>
          <label className={styles.search}>
            <Search aria-hidden="true" size={15} />
            <input
              aria-label="搜索企业空间"
              onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
              placeholder="搜索企业空间"
              ref={searchRef}
              value={query}
            />
          </label>
          <div aria-label="企业空间" className={styles.list} role="listbox">
            {filtered.map((tenant, index) => (
              <button
                aria-selected={tenant.id === activeId}
                className={`${styles.option} ${index === activeIndex ? styles.optionActive : ""}`}
                disabled={pendingId !== null}
                key={tenant.id}
                onClick={() => void choose(tenant)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                <span className={styles.optionMark}>{tenant.name.trim().slice(0, 1).toUpperCase()}</span>
                <span className={styles.optionCopy}><strong>{tenant.name}</strong><small>{tenant.slug}</small></span>
                {tenant.id === activeId ? <Check aria-hidden="true" size={16} /> : null}
                {pendingId === tenant.id ? <LoaderCircle className={styles.spin} size={16} /> : null}
              </button>
            ))}
            {filtered.length === 0 ? <p className={styles.empty}>没有匹配的企业空间</p> : null}
          </div>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
