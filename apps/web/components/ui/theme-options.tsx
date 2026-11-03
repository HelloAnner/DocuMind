"use client";

import { THEME_LABELS, useTheme } from "@/lib/theme";

/**
 * 外观三段控件：跟随系统 / 亮色 / 暗色。
 * 样式在 product-theme.css 的 .theme-options / .theme-option；与 Portal、Northline、NexusFlow 同一份。
 */
export function ThemeOptions() {
  const { preference, setPreference } = useTheme();

  return (
    <div aria-label="外观" className="theme-options" role="group">
      {THEME_LABELS.map(([value, label]) => (
        <button
          aria-pressed={preference === value}
          className="theme-option"
          key={value}
          onClick={() => setPreference(value)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
