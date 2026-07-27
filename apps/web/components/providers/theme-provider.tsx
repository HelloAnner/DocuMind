"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ProductTheme = "light" | "dark";

interface ThemeContextValue {
  theme: ProductTheme;
  setTheme: (theme: ProductTheme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = "documind:theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function themeFromDocument(): ProductTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: ProductTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, updateTheme] = useState<ProductTheme>("dark");

  useEffect(() => {
    updateTheme(themeFromDocument());
  }, []);

  const setTheme = useCallback((next: ProductTheme) => {
    applyTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    updateTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [setTheme, theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}

export const themeBootstrapScript = `
(() => {
  try {
    const saved = localStorage.getItem("${STORAGE_KEY}");
    const theme = saved === "light" || saved === "dark" ? saved : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (_) {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }
})();`;
