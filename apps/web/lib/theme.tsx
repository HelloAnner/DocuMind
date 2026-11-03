"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark";
/** 外观偏好：跟随系统（默认）或手动锁定亮/暗。四套系统同一套语义。 */
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "documind-theme";

/** 单个小图标按钮的轮换顺序：跟随系统 → 亮色 → 暗色 → 跟随系统。 */
const THEME_ORDER: ThemePreference[] = ["system", "light", "dark"];

export function themeLabel(preference: ThemePreference): string {
  return preference === "system" ? "跟随系统" : preference === "light" ? "亮色" : "暗色";
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length]!;
}

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
  /** 小图标按钮：一步轮换 跟随系统 → 亮色 → 暗色。 */
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "light",
  preference: "system",
  setPreference: () => {},
  cycleTheme: () => {},
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
        cycleTheme: () => setPreference(nextThemePreference(preference)),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
