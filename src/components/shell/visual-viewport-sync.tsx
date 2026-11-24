"use client";

import { useEffect } from "react";

const KEYBOARD_OPEN_THRESHOLD_PX = 120;
const MOBILE_BREAKPOINT_PX = 1024;

/**
 * Synchronizes iOS/Android virtual keyboard geometry from `window.visualViewport`
 * into CSS custom properties (`--vvh`, `--vv-offset-top`) and `html.keyboard-open`.
 *
 * Prevents mobile browsers (especially iOS Safari & standalone PWAs) from pushing
 * fixed bottom-sheet drawers off the top of the screen or exposing gaps above the
 * software keyboard when an input is focused.
 */
export function VisualViewportSync() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const vv = window.visualViewport;

    let rafId: number | null = null;
    let rafPending = false;
    const timers: number[] = [];

    const clearViewportVars = () => {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vv-offset-top");
      root.classList.remove("keyboard-open");
    };

    const syncNow = () => {
      rafPending = false;
      rafId = null;
      if (!vv) {
        clearViewportVars();
        return;
      }

      const layoutHeight = window.innerHeight || root.clientHeight;
      const visualHeight = Math.max(0, Math.round(vv.height));
      const offsetTop = Math.max(0, Math.round(vv.offsetTop));
      const heightDelta = layoutHeight - visualHeight;
      const isMobile = window.innerWidth < MOBILE_BREAKPOINT_PX;
      const isKeyboardOpen = isMobile && heightDelta > KEYBOARD_OPEN_THRESHOLD_PX;

      if (isKeyboardOpen || offsetTop > 0) {
        root.style.setProperty("--vvh", `${visualHeight}px`);
        root.style.setProperty("--vv-offset-top", `${offsetTop}px`);
      } else {
        root.style.removeProperty("--vvh");
        root.style.removeProperty("--vv-offset-top");
      }

      root.classList.toggle("keyboard-open", isKeyboardOpen);
    };

    const scheduleSync = () => {
      if (rafPending) return;
      rafPending = true;
      rafId = window.requestAnimationFrame(syncNow);
    };

    const handleFocusOut = () => {
      scheduleSync();
      // iOS Safari settles visualViewport slightly after blur animation completes
      timers.push(window.setTimeout(syncNow, 120));
      timers.push(window.setTimeout(syncNow, 320));
    };

    syncNow();

    vv?.addEventListener("resize", scheduleSync);
    vv?.addEventListener("scroll", scheduleSync);
    window.addEventListener("resize", scheduleSync, { passive: true });
    window.addEventListener("focusin", scheduleSync, { passive: true });
    window.addEventListener("focusout", handleFocusOut, { passive: true });

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      for (const t of timers) {
        window.clearTimeout(t);
      }
      vv?.removeEventListener("resize", scheduleSync);
      vv?.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("focusin", scheduleSync);
      window.removeEventListener("focusout", handleFocusOut);
      clearViewportVars();
    };
  }, []);

  return null;
}
