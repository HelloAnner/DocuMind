"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

/**
 * 亮/暗小图标：放在侧栏账户行右侧（与另三套系统同位置）。
 * 点击按当前生效外观切到另一侧（即手动锁定），回到“跟随系统”走账户菜单的三段控件。
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, preference, toggleTheme } = useTheme();
  const dark = theme === "dark";
  const action = dark ? "切换到亮色" : "切换到暗色";
  const current = preference === "system" ? "跟随系统" : preference === "light" ? "亮色" : "暗色";

  return (
    <button
      aria-label={action}
      className={`theme-toggle ${className}`.trim()}
      onClick={toggleTheme}
      title={`${action}（当前：${current}）`}
      type="button"
    >
      {dark ? <Sun size={16} strokeWidth={1.7} /> : <Moon size={16} strokeWidth={1.7} />}
    </button>
  );
}
