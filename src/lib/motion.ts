export type TransitionDirection = "forward" | "backward" | null;

/**
 * Unified high-energy spring & easing physics for openCalory ("The Calibration Cockpit").
 * Crisp acceleration, subtle physical settle, and unmistakable responsiveness.
 */
export const SPRING_EXPRESSIVE = {
  type: "spring" as const,
  stiffness: 320,
  damping: 26,
  mass: 0.9,
};

export const SPRING_SNAPPY = {
  type: "spring" as const,
  stiffness: 380,
  damping: 26,
  mass: 0.85,
};

export const SPRING_PILL = {
  type: "spring" as const,
  stiffness: 350,
  damping: 28,
  mass: 0.88,
};

export const SPRING_SHEET = {
  type: "spring" as const,
  stiffness: 310,
  damping: 28,
  mass: 0.92,
};

export const EASE_EXPRESSIVE = [0.22, 1, 0.36, 1] as const;

export const DURATION_UI = 0.28;
export const DURATION_PAGE = 0.24;
export const DURATION_EXIT = 0.16;

export const ROUTE_ORDER = ["/", "/log", "/trends", "/recipes", "/settings"] as const;

export function getRouteIndex(pathname: string): number {
  if (pathname === "/") return 0;
  for (let i = 1; i < ROUTE_ORDER.length; i++) {
    if (pathname.startsWith(ROUTE_ORDER[i])) return i;
  }
  return 0;
}

export function getRouteDirection(
  fromPathname: string | null,
  toPathname: string
): TransitionDirection {
  if (!fromPathname || fromPathname === toPathname) return null;
  const fromIdx = getRouteIndex(fromPathname);
  const toIdx = getRouteIndex(toPathname);
  if (toIdx > fromIdx) return "forward";
  if (toIdx < fromIdx) return "backward";
  return null;
}

export function isTestEnvironment(): boolean {
  if (typeof process !== "undefined" && Boolean(process.env?.VITEST)) {
    return true;
  }
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    return true;
  }
  return false;
}

/**
 * Triggers a subtle tactile vibration on supported mobile devices while
 * respecting the user's reduced-motion preference.
 */
export function triggerHaptic(durationMs = 10): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  try {
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(durationMs);
    }
  } catch {
    // Ignore vibration permission / sandbox failures
  }
}

type ViewTransitionDoc = Document & {
  startViewTransition?: (
    arg: (() => void) | { update: () => void; types?: string[] }
  ) => { finished: Promise<void> };
};

/**
 * Executes a DOM/state update inside document.startViewTransition when supported
 * (outside test environments), tagging both native `types` (:active-view-transition-type)
 * and `html[data-transition-direction]` for directional animations.
 */
export function runViewTransition(
  updateCb: () => void,
  options?: { direction?: TransitionDirection }
): void {
  const doc =
    typeof document !== "undefined" ? (document as ViewTransitionDoc) : null;

  if (!doc || isTestEnvironment() || typeof doc.startViewTransition !== "function") {
    updateCb();
    return;
  }

  const root = doc.documentElement;
  if (options?.direction) {
    root.dataset.transitionDirection = options.direction;
  } else {
    delete root.dataset.transitionDirection;
  }

  try {
    const transition = options?.direction
      ? doc.startViewTransition({
          update: () => updateCb(),
          types: [options.direction],
        })
      : doc.startViewTransition(() => {
          updateCb();
        });
    transition?.finished
      ?.catch(() => {})
      .finally(() => {
        delete root.dataset.transitionDirection;
      });
  } catch {
    try {
      const fallbackTransition = doc.startViewTransition(() => {
        updateCb();
      });
      fallbackTransition?.finished
        ?.catch(() => {})
        .finally(() => {
          delete root.dataset.transitionDirection;
        });
    } catch {
      delete root.dataset.transitionDirection;
      updateCb();
    }
  }
}
