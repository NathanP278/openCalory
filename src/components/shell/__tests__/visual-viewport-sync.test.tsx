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

    unmount();
  });
});
