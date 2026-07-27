"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AdminShellSidebar } from "./admin-shell-sidebar";
import { BrandMark } from "./brand-mark";
import { ThemeToggle } from "./theme-toggle";

export function ProductAdminShell({
  children,
  loading = false,
}: {
  children?: React.ReactNode;
  loading?: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <main className="dm-shell dm-product-admin-shell">
      <header className="dm-admin-mobile-header">
        <button aria-label="打开导航" className="dm-icon-button" onClick={() => setMobileOpen(true)} type="button">
          <Menu size={18} />
        </button>
        <BrandMark />
        <ThemeToggle />
      </header>

      {mobileOpen ? (
        <button className="dm-mobile-sidebar-overlay" aria-label="关闭导航" onClick={() => setMobileOpen(false)} type="button" />
      ) : null}

      <div className={`dm-admin-sidebar-drawer ${mobileOpen ? "open" : ""}`}>
        <button aria-label="关闭导航" className="dm-admin-drawer-close dm-icon-button" onClick={() => setMobileOpen(false)} type="button">
          <X size={18} />
        </button>
        <AdminShellSidebar onNavigate={() => setMobileOpen(false)} />
      </div>

      <section className={`dm-workspace ${loading ? "is-loading" : ""}`}>
        {loading ? <span className="dm-shell-loading">加载中…</span> : children}
      </section>
    </main>
  );
}
