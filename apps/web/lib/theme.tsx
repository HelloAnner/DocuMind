"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark";
/** 外观偏好：跟随系统（默认）或手动锁定亮/暗。四套系统同一套语义。 */
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "documind-theme";

/** 菜单三段控件的顺序与文案，四套系统一致。 */
export const THEME_LABELS: [ThemePreference, string][] = [
  ["system", "跟随系统"],
  ["light", "亮色"],
  ["dark", "暗色"],
];

export function parseTheme(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

/** 首屏前的内联脚本（layout 里注入）：先定主题再渲染，避免亮暗闪一下。 */
export const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem("${STORAGE_KEY}");var p=s==="dark"||s==="light"?s:"system";var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var t=p==="system"?(d?"dark":"light"):p;var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t;}catch(e){}})();`;

interface ThemeContextType {
  /** 生效外观。 */
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** 小图标按钮：按当前生效外观切到另一侧（即手动锁定）。 */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "light",
  preference: "system",
  setPreference: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [systemDark, setSystemDark] = useState(false);
  const theme = resolveTheme(preference, systemDark);

  // 读偏好 + 订阅系统主题变化（仅跟随系统时生效）与跨标签页同步。
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    try {
      setPreferenceState(parseTheme(localStorage.getItem(STORAGE_KEY)));
    } catch {
      /* 存储不可用时仍跟随系统。 */
    }
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      setPreferenceState(parseTheme(event.newValue));
    };
    mq.addEventListener("change", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setPreference = (value: ThemePreference) => {
    setPreferenceState(value);
    try {
      if (value === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* 无法持久化时，本次会话仍可切换。 */
    }
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        preference,
        setPreference,
        toggleTheme: () => setPreference(theme === "dark" ? "light" : "dark"),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
