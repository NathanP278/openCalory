import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { VisualViewportSync } from "../visual-viewport-sync";

describe("VisualViewportSync", () => {
  const originalInnerHeight = window.innerHeight;
  const originalInnerWidth = window.innerWidth;
  const originalVisualViewport = window.visualViewport;
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
    document.documentElement.style.removeProperty("--vvh");
    document.documentElement.style.removeProperty("--vv-offset-top");
    document.documentElement.classList.remove("keyboard-open");
    vi.restoreAllMocks();
  });

  it("tracks visualViewport height and offsetTop when mobile keyboard opens and resets when closed", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const mockVv = {
      height: 844,
      offsetTop: 0,
      addEventListener: (type: string, fn: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        listeners.get(type)?.delete(fn);
      },
    };

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: mockVv });

    const { unmount } = render(<VisualViewportSync />);

    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");

    // Simulate iOS keyboard opening and shifting visual viewport upward
    act(() => {
      mockVv.height = 508;
      mockVv.offsetTop = 180;
      listeners.get("resize")?.forEach((fn) => fn(new Event("resize")));
    });

    expect(document.documentElement.classList.contains("keyboard-open")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("508px");
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("180px");

    // Simulate keyboard closing
    act(() => {
      mockVv.height = 844;
      mockVv.offsetTop = 0;
      listeners.get("resize")?.forEach((fn) => fn(new Event("resize")));
    });

    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("");

    // Simulate mobile browser where window.innerHeight shrinks alongside visualViewport.height
    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
      mockVv.height = 500;
      mockVv.offsetTop = 0;
      listeners.get("resize")?.forEach((fn) => fn(new Event("resize")));
    });

    expect(document.documentElement.classList.contains("keyboard-open")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("500px");

    unmount();
  });

  it("skips redundant DOM writes when visualViewport metrics are unchanged", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const mockVv = {
      height: 844,
      offsetTop: 0,
      addEventListener: (type: string, fn: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        listeners.get(type)?.delete(fn);
      },
    };

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: mockVv });

    const setSpy = vi.spyOn(document.documentElement.style, "setProperty");
    const removeSpy = vi.spyOn(document.documentElement.style, "removeProperty");

    const { unmount } = render(<VisualViewportSync />);
    setSpy.mockClear();
    removeSpy.mockClear();

    // First keyboard open writes --vvh and --vv-offset-top once
    act(() => {
      mockVv.height = 508;
      mockVv.offsetTop = 120;
      listeners.get("resize")?.forEach((fn) => fn(new Event("resize")));
    });
    expect(setSpy).toHaveBeenCalledTimes(2);

    // Identical resize event should perform zero redundant style writes
    act(() => {
      listeners.get("resize")?.forEach((fn) => fn(new Event("resize")));
    });
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(0);

    unmount();
  });

  it("does not attach a window scroll listener or mutate styles on window scroll", () => {
    const mockVv = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: mockVv });

    const addListenerSpy = vi.spyOn(window, "addEventListener");
    const setSpy = vi.spyOn(document.documentElement.style, "setProperty");

    const { unmount } = render(<VisualViewportSync />);
    setSpy.mockClear();

    const scrollRegistrations = addListenerSpy.mock.calls.filter(([type]) => type === "scroll");
    expect(scrollRegistrations).toHaveLength(0);

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(setSpy).not.toHaveBeenCalled();

    unmount();
  });

  it("coalesces focusin settle timers instead of accumulating overlapping timers", () => {
    vi.useFakeTimers();
    try {
      const mockVv = {
        height: 844,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: mockVv });

      const { unmount } = render(<VisualViewportSync />);

      act(() => {
        window.dispatchEvent(new Event("focusin"));
        window.dispatchEvent(new Event("focusin"));
        window.dispatchEvent(new Event("focusin"));
      });

      expect(vi.getTimerCount()).toBeLessThanOrEqual(3);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears stale keyboard state when crossing from mobile (<1024px) to desktop (>=1024px)", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const mockVv = {
      height: 844,
      offsetTop: 0,
      addEventListener: (type: string, fn: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        listeners.get(type)?.delete(fn);
      },
    };

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: mockVv });

    const { unmount } = render(<VisualViewportSync />);

    // Open keyboard on mobile
    act(() => {
      mockVv.height = 500;
      mockVv.offsetTop = 100;
      listeners.get("resize")?.forEach((fn) => fn(new Event("resize")));
    });
    expect(document.documentElement.classList.contains("keyboard-open")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("500px");

    // Rotate/unfold to desktop width (>= 1024px)
    const setSpy = vi.spyOn(document.documentElement.style, "setProperty");
    const removeSpy = vi.spyOn(document.documentElement.style, "removeProperty");
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
      window.dispatchEvent(new Event("resize"));
    });

    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("");

    // Subsequent desktop resizes must be zero-write no-ops
    setSpy.mockClear();
    removeSpy.mockClear();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();

    unmount();
  });
});
