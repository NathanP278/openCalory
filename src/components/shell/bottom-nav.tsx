"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  LayoutGrid,
  Apple,
  Plus,
  UtensilsCrossed,
  TrendingUp,
  Search,
  ScanBarcode,
  Sparkles,
} from "lucide-react";
import { useLoggerStore } from "@/stores/logger-store";
import {
  EASE_EXPRESSIVE,
  SPRING_PILL,
  SPRING_SNAPPY,
  isTestEnvironment,
  triggerHaptic,
} from "@/lib/motion";
import type { QuickActionType } from "./quick-action-dock";

export interface BottomNavProps {
  onOpenQuickActions: () => void;
  onDirectAction?: (action: QuickActionType) => void;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS_LEFT: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutGrid },
  { label: "Food Log", href: "/log", icon: Apple },
];

const NAV_ITEMS_RIGHT: NavItem[] = [
  { label: "Trends", href: "/trends", icon: TrendingUp },
  { label: "Recipes", href: "/recipes", icon: UtensilsCrossed },
];

export function BottomNav({ onOpenQuickActions, onDirectAction }: BottomNavProps) {
  const pathname = usePathname() ?? "/";
  const setCommandPaletteOpen = useLoggerStore((s) => s.setCommandPaletteOpen);

  const showQuickSearchBar =
    Boolean(onDirectAction) &&
    (pathname === "/" || pathname.startsWith("/log"));

  const isItemActive = (href: string) => {
    if (href === "/") {
      return pathname === "/";
    }
    return pathname.startsWith(href);
  };

  return (
    <div
      style={{ viewTransitionName: "bottom-chrome" }}
      className="mobile-bottom-chrome fixed bottom-0 left-0 right-0 z-40 pointer-events-none lg:hidden bg-gradient-to-t from-background/92 via-background/55 to-transparent pt-5"
    >
      {/* Persistent Quick Search Strip on Dashboard & Food Log */}
      <AnimatePresence initial={false}>
        {showQuickSearchBar && onDirectAction && (
          <motion.div
            key="quick-search-strip"
            initial={isTestEnvironment() ? false : { opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={isTestEnvironment() ? undefined : { opacity: 0, y: 14, scale: 0.96 }}
            transition={{ duration: 0.34, ease: EASE_EXPRESSIVE }}
          >
            <div className="max-w-2xl mx-auto pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:px-6 pb-2.5 pointer-events-auto">
              <div className="liquid-input-well surface-floating-bar rounded-full h-12 px-3 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(8);
                  onDirectAction("search");
                }}
                aria-label="Search for a food"
                className="tactile-press flex-1 flex items-center gap-2.5 text-left text-muted-foreground hover:text-foreground transition-colors h-full min-w-0 group px-1.5"
              >
                <Search
                  className="w-4 h-4 shrink-0 transition-transform duration-200 group-hover:scale-110"
                  aria-hidden="true"
                />
                <span className="text-sm font-medium truncate">
                  Search for a food
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  triggerHaptic(8);
                  setCommandPaletteOpen(true);
                }}
                aria-label="Open command palette"
                className="hidden sm:inline-flex tactile-press items-center gap-1 px-2.5 py-1 rounded-full liquid-pill-glass text-[11px] font-mono text-muted-foreground hover:text-foreground shrink-0"
              >
                <span>⌘K</span>
              </button>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic(8);
                    onDirectAction("barcode");
                  }}
                  aria-label="Open barcode camera"
                  className="touch-target tactile-press min-w-[44px] min-h-[44px] sm:min-w-0 sm:px-3 sm:h-8 rounded-full flex items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-surface-sub"
                >
                  <ScanBarcode className="w-4 h-4" aria-hidden="true" />
                  <span className="hidden sm:inline text-[11px] font-medium">
                    Barcode
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic(8);
                    onDirectAction("ai-scan");
                  }}
                  aria-label="Open photo scanner"
                  className="touch-target tactile-press min-w-[44px] min-h-[44px] sm:min-w-0 sm:px-3 sm:h-8 rounded-full flex items-center justify-center gap-1.5 text-foreground hover:bg-surface-sub"
                >
                  <Sparkles className="w-4 h-4" aria-hidden="true" />
                  <span className="hidden sm:inline text-[11px] font-semibold">
                    AI Scan
                  </span>
                </button>
              </div>
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Smoked Liquid Glass Navigation Capsule */}
      <div className="pb-[max(0.6rem,env(safe-area-inset-bottom))] pt-1 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:px-6">
        <nav
          data-testid="bottom-nav"
          aria-label="Bottom Navigation"
          className="pointer-events-auto max-w-2xl mx-auto bg-surface-card border border-border surface-floating-bar rounded-full"
        >
          <div className="h-[62px] px-2.5 sm:px-4 flex items-center justify-between gap-1">
          {/* Left Nav items */}
          <div className="flex items-center gap-0.5 flex-1 justify-around min-w-0">
            {NAV_ITEMS_LEFT.map((item) => {
              const Icon = item.icon;
              const active = isItemActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => triggerHaptic(8)}
                  className={`touch-target tactile-press relative flex flex-col items-center justify-center flex-1 min-w-0 min-h-[44px] py-1.5 rounded-full ${
                    active
                      ? "text-foreground font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="relative flex items-center justify-center w-12 h-7 rounded-full mb-0.5">
                    {active && (
                      <motion.span
                        layoutId="bottom-nav-active-pill"
                        transition={SPRING_PILL}
                        aria-hidden="true"
                        className="absolute inset-0 rounded-full bg-foreground/14 border border-border-focus liquid-glass-active-pill"
                      />
                    )}
                    <Icon
                      aria-hidden="true"
                      className={`relative z-10 w-[19px] h-[19px] transition-transform duration-200 ${
                        active ? "stroke-[2.25] scale-110" : "stroke-[1.75]"
                      }`}
                    />
                  </span>
                  <span className="text-[10px] sm:text-[11px] tracking-tight whitespace-nowrap">
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>

          {/* Volumetric Neutral Liquid Glass Center '+' Action Pill */}
          <div className="px-2 sm:px-4 shrink-0">
            <motion.button
              type="button"
              onClick={onOpenQuickActions}
              aria-label="Open quick actions"
              whileHover={{ scale: 1.05, y: -1.5 }}
              whileTap={{ scale: 0.93 }}
              transition={SPRING_SNAPPY}
              className="group touch-target w-11 h-11 rounded-full liquid-pill-primary flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
            >
              <Plus
                className="w-5 h-5 stroke-[2.5] transition-transform duration-300 group-hover:rotate-90"
                aria-hidden="true"
              />
            </motion.button>
          </div>

          {/* Right Nav items */}
          <div className="flex items-center gap-0.5 flex-1 justify-around min-w-0">
            {NAV_ITEMS_RIGHT.map((item) => {
              const Icon = item.icon;
              const active = isItemActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => triggerHaptic(8)}
                  className={`touch-target tactile-press relative flex flex-col items-center justify-center flex-1 min-w-0 min-h-[44px] py-1.5 rounded-full ${
                    active
                      ? "text-foreground font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="relative flex items-center justify-center w-12 h-7 rounded-full mb-0.5">
                    {active && (
                      <motion.span
                        layoutId="bottom-nav-active-pill"
                        transition={SPRING_PILL}
                        aria-hidden="true"
                        className="absolute inset-0 rounded-full bg-foreground/14 border border-border-focus liquid-glass-active-pill"
                      />
                    )}
                    <Icon
                      aria-hidden="true"
                      className={`relative z-10 w-[19px] h-[19px] transition-transform duration-200 ${
                        active ? "stroke-[2.25] scale-110" : "stroke-[1.75]"
                      }`}
                    />
                  </span>
                  <span className="text-[10px] sm:text-[11px] tracking-tight whitespace-nowrap">
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
          </div>
        </nav>
      </div>
    </div>
  );
}
