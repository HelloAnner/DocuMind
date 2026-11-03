"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { nextThemePreference, themeLabel, useTheme } from "@/lib/theme";

/**
 * 外观小图标：侧栏账户行最右侧的 26px 按钮，一步轮换 跟随系统 → 亮色 → 暗色。
 * 三个系统（DocuMind / Northline / NexusFlow）同一个组件、同一份样式，Portal 用同名 class 实现。
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { preference, cycleTheme } = useTheme();
  const title = `外观：${themeLabel(preference)}（点击切换到${themeLabel(nextThemePreference(preference))}）`;

  return (
    <button
      aria-label={title}
      className={`theme-toggle ${className}`.trim()}
      onClick={cycleTheme}
      title={title}
      type="button"
    >
      {preference === "system" ? (
        <Monitor size={16} strokeWidth={1.7} />
      ) : preference === "light" ? (
        <Sun size={16} strokeWidth={1.7} />
      ) : (
        <Moon size={16} strokeWidth={1.7} />
      )}
    </button>
  );
}
