"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: ResolvedTheme;
}

const STORAGE_KEY = "opencalory-theme";
const DEFAULT_THEME: Theme = "dark";

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }
  return theme;
}

let themeTransitionTimer: ReturnType<typeof setTimeout> | null = null;

function applyThemeClass(resolved: ResolvedTheme, animate = false) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const currentIsLight = root.classList.contains("light");
  const currentIsDark = root.classList.contains("dark");
  const changed =
    (resolved === "light" && !currentIsLight) ||
    (resolved === "dark" && !currentIsDark);

  if (animate && changed) {
    root.classList.add("theme-transitioning");
    if (themeTransitionTimer) {
      clearTimeout(themeTransitionTimer);
    }
    themeTransitionTimer = setTimeout(() => {
      root.classList.remove("theme-transitioning");
      themeTransitionTimer = null;
    }, 460);
  }

  root.classList.remove("light", "dark");
  root.classList.add(resolved);

  // Sync iOS Safari status-bar / bottom-bar tint with the active in-app theme
  const themeColor = resolved === "light" ? "#f2f4f8" : "#1e2229";
  const existing = document.querySelectorAll('meta[name="theme-color"]');
  if (existing.length > 0) {
    existing.forEach((meta) => {
      meta.setAttribute("content", themeColor);
    });
  } else {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = themeColor;
    document.head.appendChild(meta);
  }
}

export function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
  storageKey = STORAGE_KEY,
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    defaultTheme === "light" ? "light" : "dark"
  );

  // Sync saved localStorage theme after mount to prevent SSR/client hydration mismatch
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = localStorage.getItem(storageKey) as Theme | null;
      if (saved && (saved === "dark" || saved === "light" || saved === "system")) {
        setThemeState(saved);
        const resolved = resolveTheme(saved);
        setResolvedTheme(resolved);
        applyThemeClass(resolved);
        return;
      }
    } catch {
      // localStorage unavailable
    }
    const resolved = resolveTheme(defaultTheme);
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
  }, [defaultTheme, storageKey]);

  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyThemeClass(resolved);

    if (theme === "system" && typeof window !== "undefined" && window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = () => {
        const updated = mediaQuery.matches ? "dark" : "light";
        setResolvedTheme(updated);
        applyThemeClass(updated);
      };

      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener("change", handleChange);
        return () => mediaQuery.removeEventListener("change", handleChange);
      } else if (mediaQuery.addListener) {
        mediaQuery.addListener(handleChange);
        return () => mediaQuery.removeListener(handleChange);
      }
    }
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    try {
      localStorage.setItem(storageKey, newTheme);
    } catch {
      // localStorage unavailable
    }
    const resolved = resolveTheme(newTheme);
    setThemeState(newTheme);
    setResolvedTheme(resolved);
    applyThemeClass(resolved, true);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

export function useOptionalTheme(): ThemeContextType | null {
  return useContext(ThemeContext) ?? null;
}
