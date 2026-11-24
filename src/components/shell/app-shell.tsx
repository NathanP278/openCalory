"use client";

import React, { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { AnimatePresence } from "motion/react";
import { Lock, ShieldCheck, X } from "lucide-react";
import { BottomNav } from "./bottom-nav";
import { DesktopSidebar } from "./desktop-sidebar";
import { QuickActionDock, QuickActionType } from "./quick-action-dock";
import { UndoToast } from "./undo-toast";
import { CommandPalette } from "./command-palette";
import { SyncUnlockCard } from "@/components/auth/sync-unlock-modal";
import {
  MotionModalOverlay,
  PageTransitionStage,
} from "@/components/motion/motion-primitives";
import { useRouteDirection } from "@/components/motion/route-direction-context";
import { QuickAddDrawer } from "@/components/logging/quick-add-drawer";
import { FoodSearchDrawer } from "@/components/logging/food-search-drawer";
import { useLoggerStore } from "@/stores/logger-store";
import { ensureDefaultUserGoals } from "@/lib/nutrition/goals";
import { db } from "@/lib/db/opencalory-db";
import { isCloudSyncEnabled, syncWithCentralDb } from "@/lib/db/cloud-sync";
import { initClientCatalogIfCached } from "@/lib/foods/client-catalog";
import { isTestEnvironment, triggerHaptic } from "@/lib/motion";
import { useFocusTrap } from "@/hooks/use-focus-trap";

const EditLogEntryDrawer = dynamic(
  () =>
    import("@/components/logging/edit-log-entry-drawer").then(
      (mod) => mod.EditLogEntryDrawer
    ),
  { ssr: false }
);
const BarcodeScannerDrawer = dynamic(
  () =>
    import("@/components/scanner/barcode-scanner-drawer").then(
      (mod) => mod.BarcodeScannerDrawer
    ),
  { ssr: false }
);
const AiMealScannerSheet = dynamic(
  () =>
    import("@/components/scanner/ai-meal-scanner-sheet").then(
      (mod) => mod.AiMealScannerSheet
    ),
  { ssr: false }
);
const AiMealIdeasDrawer = dynamic(
  () =>
    import("@/components/scanner/ai-meal-ideas-drawer").then(
      (mod) => mod.AiMealIdeasDrawer
    ),
  { ssr: false }
);
const WeighInDrawer = dynamic(
  () =>
    import("@/components/weight/weigh-in-drawer").then(
      (mod) => mod.WeighInDrawer
    ),
  { ssr: false }
);

export { QuickActionDock };
export type { QuickActionType };

export interface AppShellProps {
  children: React.ReactNode;
  onQuickAction?: (action: QuickActionType) => void;
}

function SyncAuthModal() {
  const [isDismissed, setIsDismissed] = useState(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, !isDismissed);

  useEffect(() => {
    if (isDismissed) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setIsDismissed(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDismissed]);

  const handleContinueLocal = () => {
    triggerHaptic(8);
    setIsDismissed(true);
  };

  return (
    <MotionModalOverlay
      open={!isDismissed}
      onClose={handleContinueLocal}
      ariaLabel="Sign in to Cloud Sync & AI"
      dataTestId="sync-auth-modal"
      align="center"
      panelRef={modalRef}
      panelClassName="w-full max-w-md surface-elevated-sheet rounded-3xl p-5 sm:p-6 space-y-4"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full liquid-pill-glass flex items-center justify-center text-foreground shrink-0">
            <Lock className="w-4.5 h-4.5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold tracking-tight text-foreground">
              Sign in to Cloud Sync
            </h2>
            <p className="text-xs text-muted-foreground">
              Optional cross-device sync &amp; AI meal scanning
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleContinueLocal}
          aria-label="Close cloud sync sign in"
          className="touch-target tactile-press w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-sub shrink-0"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* Passphrase Unlock Form */}
      <SyncUnlockCard
        compact
        onUnlocked={() => {
          if (isCloudSyncEnabled()) {
            void syncWithCentralDb(db).catch(() => {});
          }
        }}
      />

      {/* Local-first zero-guilt exit */}
      <div className="pt-1 flex flex-col gap-2">
        <button
          type="button"
          onClick={handleContinueLocal}
          className="touch-target w-full py-2.5 px-4 rounded-full liquid-pill-glass text-xs font-semibold text-foreground flex items-center justify-center gap-1.5"
        >
          <ShieldCheck className="w-3.5 h-3.5 text-foreground/80" aria-hidden="true" />
          <span>Continue in Local Mode</span>
        </button>
        <p className="text-[11px] text-center text-muted-foreground">
          Your meals, recipes, and weigh-ins stay 100% stored offline on this device. You can unlock anytime in Settings.
        </p>
      </div>
    </MotionModalOverlay>
  );
}

export function AppShell({ children, onQuickAction }: AppShellProps) {
  const [isDockOpen, setIsDockOpen] = useState(false);
  const pathname = usePathname() ?? "/";
  const { direction: routeDirection } = useRouteDirection();
  const hasQuickSearchBar =
    pathname === "/" || pathname === "/log" || pathname.startsWith("/log/");
  const activeSheet = useLoggerStore((s) => s.activeSheet);
  const openSheet = useLoggerStore((s) => s.openSheet);
  const closeSheet = useLoggerStore((s) => s.closeSheet);
  const activeDate = useLoggerStore((s) => s.activeDate);
  const activeMealSlot = useLoggerStore((s) => s.activeMealSlot);
  const editingEntry = useLoggerStore((s) => s.editingEntry);
  const setEditingEntry = useLoggerStore((s) => s.setEditingEntry);
  const editingWeight = useLoggerStore((s) => s.editingWeight);
  const syncAuthLocked = useLoggerStore((s) => s.syncAuthLocked);

  // Restore & debounced persist per-route scroll position (never writes synchronously inside scroll handler)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `macro_scroll_${pathname}`;
    try {
      const saved = window.sessionStorage?.getItem(key);
      if (saved) {
        const y = parseInt(saved, 10);
        if (Number.isFinite(y) && y > 0) {
          requestAnimationFrame(() => {
            window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
          });
        }
      }
    } catch {
      // sessionStorage unavailable
    }

    let scrollTimer: number | null = null;
    const persistScrollNow = () => {
      if (scrollTimer !== null) {
        window.clearTimeout(scrollTimer);
        scrollTimer = null;
      }
      try {
        window.sessionStorage?.setItem(key, String(Math.round(window.scrollY)));
      } catch {
        // Ignore storage errors
      }
    };

    const handleScroll = () => {
      if (scrollTimer !== null) {
        window.clearTimeout(scrollTimer);
      }
      scrollTimer = window.setTimeout(persistScrollNow, 250);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("pagehide", persistScrollNow);
    return () => {
      persistScrollNow();
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("pagehide", persistScrollNow);
    };
  }, [pathname]);

  // Warm-only OPFS catalog worker preload during idle (zero network on cold first visits)
  useEffect(() => {
    if (typeof window === "undefined" || isTestEnvironment()) return;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const triggerWarm = () => {
      void initClientCatalogIfCached();
    };
    if (typeof win.requestIdleCallback === "function") {
      const idleId = win.requestIdleCallback(triggerWarm, { timeout: 1500 });
      return () => win.cancelIdleCallback?.(idleId);
    }
    const timeoutId = window.setTimeout(triggerWarm, 1500);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initData() {
      if (isCloudSyncEnabled()) {
        await syncWithCentralDb(db).catch((err) => {
          console.error("Central DB sync warning:", err);
        });
      }
      if (!cancelled) {
        await ensureDefaultUserGoals().catch((err) => {
          console.error("Failed to seed default user goals:", err);
        });
      }
    }

    initData();

    if (!isCloudSyncEnabled()) {
      return () => {
        cancelled = true;
      };
    }

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        syncWithCentralDb(db).catch(() => {});
      }
    };

    window.addEventListener("focus", handleVisibility);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleVisibility);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const handleAction = (action: QuickActionType) => {
    triggerHaptic(8);
    setIsDockOpen(false);
    openSheet(action);
    onQuickAction?.(action);
  };

  return (
    <div className="min-h-dvh bg-background text-foreground lg:flex lg:items-start">
      {/* Translucent top safe-area scrim so scrolled content never clashes with iOS/Android status bar */}
      <div
        aria-hidden="true"
        className="fixed top-0 left-0 right-0 z-40 h-[env(safe-area-inset-top)] bg-background/85 backdrop-blur-md pointer-events-none"
      />

      {/* Persistent Desktop Left Sidebar Rail (lg+) */}
      <DesktopSidebar
        onOpenQuickActions={() => {
          triggerHaptic(10);
          setIsDockOpen(true);
        }}
        onDirectAction={handleAction}
      />

      {/* Dynamic responsive workspace: mobile-first full bleed, expands gracefully on tablets & laptops */}
      <div
        data-testid="app-shell-container"
        className={`flex-1 min-w-0 w-full max-w-6xl mx-auto min-h-dvh flex flex-col relative pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] ${
          hasQuickSearchBar
            ? "pb-[calc(9.5rem+env(safe-area-inset-bottom))] sm:pb-[calc(10rem+env(safe-area-inset-bottom))] lg:pb-8"
            : "pb-[calc(6.25rem+env(safe-area-inset-bottom))] sm:pb-[calc(6.75rem+env(safe-area-inset-bottom))] lg:pb-8"
        }`}
      >
        {syncAuthLocked && <SyncAuthModal />}

        <AnimatePresence initial={false}>
          <PageTransitionStage
            routeKey={pathname}
            direction={routeDirection}
            className="flex-1 flex flex-col w-full"
          >
            {children}
          </PageTransitionStage>
        </AnimatePresence>

        {/* Floating Undo Toast */}
        <UndoToast />

        {/* Desktop Command Palette (Cmd/Ctrl + K) */}
        <CommandPalette />

        {/* Persistent quick search strip + fixed bottom navigation */}
        <BottomNav
          onOpenQuickActions={() => {
            triggerHaptic(10);
            setIsDockOpen(true);
          }}
          onDirectAction={handleAction}
        />

        {/* Quick action overlay dock (AnimatePresence inside QuickActionDock) */}
        <QuickActionDock
          open={isDockOpen}
          onAction={handleAction}
          onClose={() => setIsDockOpen(false)}
        />

        {/* Quick Add Macros Drawer */}
        <QuickAddDrawer
          open={activeSheet === "quick-add"}
          date={activeDate}
          mealSlot={activeMealSlot}
          onClose={closeSheet}
        />

        {/* Food Search Drawer */}
        <FoodSearchDrawer
          open={activeSheet === "search"}
          date={activeDate}
          mealSlot={activeMealSlot}
          onClose={closeSheet}
        />

        {/* Lazy-loaded heavy drawers (chunks fetched & parsed only when opened) */}
        {activeSheet === "barcode" && (
          <BarcodeScannerDrawer
            open
            date={activeDate}
            mealSlot={activeMealSlot}
            onClose={closeSheet}
          />
        )}

        {activeSheet === "ai-scan" && (
          <AiMealScannerSheet
            open
            date={activeDate}
            mealSlot={activeMealSlot}
            onClose={closeSheet}
          />
        )}

        {activeSheet === "meal-ideas" && (
          <AiMealIdeasDrawer
            open
            date={activeDate}
            onClose={closeSheet}
          />
        )}

        {activeSheet === "weight" && (
          <WeighInDrawer
            open
            initialEntry={editingWeight}
            defaultDate={activeDate}
            onClose={closeSheet}
          />
        )}

        {editingEntry !== null && (
          <EditLogEntryDrawer
            entry={editingEntry}
            onClose={() => setEditingEntry(null)}
          />
        )}
      </div>
    </div>
  );
}
