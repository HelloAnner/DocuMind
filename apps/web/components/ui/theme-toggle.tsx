"use client";

import { Moon, Sun } from "lucide-react";
import { clsx } from "clsx";
import { useTheme } from "@/components/providers/theme-provider";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const nextLabel = theme === "dark" ? "切换到明亮主题" : "切换到深色主题";

  return (
    <button
      aria-label={nextLabel}
      className={clsx("dm-theme-toggle", className)}
      onClick={toggleTheme}
      title={nextLabel}
      type="button"
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
