"use client";

import { ChevronDown, Handshake, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { switchAccountTenant, type Tenant } from "@/lib/auth";
import styles from "./tenant-switcher.module.css";
export function TenantSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { me } = useAuth();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
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
    setActiveIndex(0);
    setError("");
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

  const coCreatedTenants = tenants.filter((tenant) => tenant.id !== activeId);
  const selectableTenants = [activeTenant, ...coCreatedTenants];

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
      setActiveIndex((index) => (index + direction + selectableTenants.length) % Math.max(selectableTenants.length, 1));
      return;
    }
    if (event.key === "Enter" && selectableTenants[activeIndex]) {
      event.preventDefault();
      void choose(selectableTenants[activeIndex]);
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
          <div aria-label="企业空间" className={styles.list} role="listbox">
            <section className={styles.section}>
              <div className={styles.sectionLabel}>
                <Sparkles aria-hidden="true" size={17} />
                <span>个人空间</span>
              </div>
              <button
                aria-selected="true"
                className={styles.option}
                disabled={pendingId !== null}
                onClick={() => void choose(activeTenant)}
                onMouseEnter={() => setActiveIndex(0)}
                role="option"
                type="button"
              >
                <span className={styles.optionCopy}><strong>{activeTenant.name}</strong></span>
                <span className={styles.currentBadge}>当前</span>
                {pendingId === activeTenant.id ? <LoaderCircle className={styles.spin} size={16} /> : null}
              </button>
            </section>
            {coCreatedTenants.length > 0 ? (
              <>
                <div className={styles.divider} />
                <section className={styles.section}>
                  <div className={styles.sectionLabel}>
                    <Handshake aria-hidden="true" size={17} />
                    <span>共创空间</span>
                  </div>
                  {coCreatedTenants.map((tenant, index) => {
                    const optionIndex = index + 1;
                    return (
                      <button
                        aria-selected="false"
                        className={`${styles.option} ${styles.coCreatedOption} ${optionIndex === activeIndex ? styles.optionActive : ""}`}
                        disabled={pendingId !== null}
                        key={tenant.id}
                        onClick={() => void choose(tenant)}
                        onMouseEnter={() => setActiveIndex(optionIndex)}
                        role="option"
                        type="button"
                      >
                        <span className={styles.optionCopy}><strong>{tenant.name}</strong></span>
                        {pendingId === tenant.id ? <LoaderCircle className={styles.spin} size={16} /> : null}
                      </button>
                    );
                  })}
                </section>
              </>
            ) : null}
          </div>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
