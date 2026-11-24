"use client";

import { useEffect } from "react";

const KEYBOARD_OPEN_THRESHOLD_PX = 120;
const MOBILE_BREAKPOINT_PX = 1024;

/**
 * Synchronizes iOS/Android virtual keyboard geometry from `window.visualViewport`
 * into CSS custom properties (`--vvh`, `--vv-offset-top`) and `html.keyboard-open`.
 *
 * Diffs all DOM writes so unchanged frames are zero-cost no-ops, coalesces focus
 * settle timers, and avoids waking on normal document `window.scroll` events.
 */
export function VisualViewportSync() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const vv = window.visualViewport;

    let rafId: number | null = null;
    let rafPending = false;
    let focusTimers: number[] = [];
    let lastWidth = window.innerWidth;
    let maxViewportHeight = Math.max(
      window.innerHeight || 0,
      root.clientHeight || 0,
      vv ? Math.round(vv.height) : 0
    );

    let lastVvh: string | null = null;
    let lastOffsetTop: string | null = null;
    let lastKeyboardOpen = false;

    const clearFocusTimers = () => {
      if (focusTimers.length === 0) return;
      for (const t of focusTimers) {
        window.clearTimeout(t);
      }
      focusTimers = [];
    };

    const applyState = (
      nextVvh: string | null,
      nextOffsetTop: string | null,
      nextKeyboardOpen: boolean
    ) => {
      if (nextVvh !== lastVvh) {
        if (nextVvh === null) {
          root.style.removeProperty("--vvh");
        } else {
          root.style.setProperty("--vvh", nextVvh);
        }
        lastVvh = nextVvh;
      }

      if (nextOffsetTop !== lastOffsetTop) {
        if (nextOffsetTop === null) {
          root.style.removeProperty("--vv-offset-top");
        } else {
          root.style.setProperty("--vv-offset-top", nextOffsetTop);
        }
        lastOffsetTop = nextOffsetTop;
      }

      if (nextKeyboardOpen !== lastKeyboardOpen) {
        root.classList.toggle("keyboard-open", nextKeyboardOpen);
        lastKeyboardOpen = nextKeyboardOpen;
      }
    };

    const syncNow = () => {
      rafPending = false;
      rafId = null;

      const currentWidth = window.innerWidth;
      if (!vv || currentWidth >= MOBILE_BREAKPOINT_PX) {
        lastWidth = currentWidth;
        applyState(null, null, false);
        return;
      }

      const layoutHeight = window.innerHeight || root.clientHeight;
      const visualHeight = Math.max(0, Math.round(vv.height));
      const offsetTop = Math.max(0, Math.round(vv.offsetTop));

      // Reset baseline on orientation/viewport width change
      if (Math.abs(currentWidth - lastWidth) > 40) {
        lastWidth = currentWidth;
        maxViewportHeight = Math.max(layoutHeight, visualHeight);
      } else {
        maxViewportHeight = Math.max(maxViewportHeight, layoutHeight, visualHeight);
      }

      const heightDelta = Math.max(
        layoutHeight - visualHeight,
        maxViewportHeight - visualHeight
      );
      const isKeyboardOpen = heightDelta > KEYBOARD_OPEN_THRESHOLD_PX;

      if (isKeyboardOpen || offsetTop > 0) {
        applyState(`${visualHeight}px`, `${offsetTop}px`, isKeyboardOpen);
      } else {
        applyState(null, null, false);
      }
    };

    const scheduleSync = () => {
      if (rafPending) return;
      rafPending = true;
      rafId = window.requestAnimationFrame(syncNow);
    };

    const handleFocusIn = () => {
      if (window.innerWidth >= MOBILE_BREAKPOINT_PX) return;
      clearFocusTimers();
      scheduleSync();
      // iOS Safari / standalone PWA animates the keyboard over ~300ms
      focusTimers = [
        window.setTimeout(syncNow, 60),
        window.setTimeout(syncNow, 180),
        window.setTimeout(syncNow, 360),
      ];
    };

    const handleFocusOut = () => {
      if (window.innerWidth >= MOBILE_BREAKPOINT_PX && !lastKeyboardOpen) return;
      clearFocusTimers();
      scheduleSync();
      // iOS Safari settles visualViewport slightly after blur animation completes
      focusTimers = [
        window.setTimeout(syncNow, 120),
        window.setTimeout(syncNow, 320),
      ];
    };

    syncNow();

    vv?.addEventListener("resize", scheduleSync);
    vv?.addEventListener("scroll", scheduleSync);
    window.addEventListener("resize", scheduleSync, { passive: true });
    window.addEventListener("focusin", handleFocusIn, { passive: true });
    window.addEventListener("focusout", handleFocusOut, { passive: true });

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      clearFocusTimers();
      vv?.removeEventListener("resize", scheduleSync);
      vv?.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("focusout", handleFocusOut);
      applyState(null, null, false);
    };
  }, []);

  return null;
}
