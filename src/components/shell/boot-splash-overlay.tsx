"use client";

import React from "react";
import { Check, Lock, ShieldCheck } from "lucide-react";
import { SyncUnlockCard } from "@/components/auth/sync-unlock-modal";

export type BootOverlayMode = "checking" | "confirmed" | "locked";

export interface BootSplashOverlayProps {
  visible: boolean;
  exiting: boolean;
  statusLabel: string;
  mode?: BootOverlayMode;
  onUnlocked?: () => void;
}

/**
 * Full-screen Smoked Liquid Glass boot & Cloud Sync access gate.
 * Renders opaquely over the viewport before any page content mounts, confirms
 * Cloud Sync access quickly while staying prominent, and dissolves smoothly
 * into the live app once verified.
 */
export function BootSplashOverlay({
  visible,
  exiting,
  statusLabel,
  mode = "checking",
  onUnlocked,
}: BootSplashOverlayProps) {
  if (!visible) return null;

  const size = 84;
  const cx = size / 2;
  const cy = size / 2 + 2;
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const arcSpan = circumference * (240 / 360);
  const isConfirmed = mode === "confirmed";
  const isLocked = mode === "locked";

  return (
    <div
      role={isLocked ? "dialog" : "status"}
      aria-modal={isLocked ? "true" : undefined}
      aria-live={isLocked ? undefined : "polite"}
      aria-label={isLocked ? "Cloud Sync Access Required" : statusLabel}
      data-testid="boot-splash-overlay"
      data-boot-mode={mode}
      className={`fixed inset-0 z-[90] flex flex-col items-center justify-center px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-background overflow-y-auto ${
        exiting ? "boot-splash-exit pointer-events-none" : "boot-splash-enter"
      }`}
    >
      {/* Subtle ambient glow matching the smoked obsidian canvas */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-90"
        style={{ backgroundImage: "var(--canvas-ambient)" }}
      />

      <div className="relative z-10 w-full max-w-sm flex flex-col items-center gap-5">
        {/* Smoked Liquid Glass Calibration Emblem */}
        <div
          className={`relative w-24 h-24 rounded-[28px] surface-elevated-sheet flex items-center justify-center overflow-hidden boot-emblem-enter transition-transform duration-300 ${
            isConfirmed ? "scale-[1.03]" : ""
          }`}
        >
          {/* Specular traveling sheen */}
          <div
            aria-hidden="true"
            className="boot-glass-sheen pointer-events-none absolute inset-0"
          />

          {/* Calibrating 240-deg Calorie Arc */}
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="w-[74px] h-[74px] overflow-visible relative z-10"
            aria-hidden="true"
          >
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="var(--surface-sub)"
              strokeWidth="5.5"
              strokeDasharray={`${arcSpan} ${circumference}`}
              strokeLinecap="round"
              transform={`rotate(150 ${cx} ${cy})`}
            />
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={
                isConfirmed
                  ? "var(--macro-carbs)"
                  : isLocked
                    ? "var(--neutral-over)"
                    : "var(--macro-calories)"
              }
              strokeWidth="5.5"
              strokeDasharray={`${arcSpan} ${circumference}`}
              strokeLinecap="round"
              transform={`rotate(150 ${cx} ${cy})`}
              className="boot-arc-sweep transition-colors duration-300"
              style={
                {
                  "--boot-arc-span": `${arcSpan}`,
                } as React.CSSProperties
              }
            />
          </svg>

          {/* Center Emblem Indicator */}
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center pt-1.5 z-10"
          >
            {isConfirmed ? (
              <span className="w-7 h-7 rounded-full bg-[var(--macro-carbs)]/18 border border-[var(--macro-carbs)]/35 flex items-center justify-center text-[var(--macro-carbs)] animate-check-pop">
                <Check className="w-4 h-4 stroke-[2.5]" />
              </span>
            ) : isLocked ? (
              <span className="w-7 h-7 rounded-full bg-surface-sub border border-border flex items-center justify-center text-foreground">
                <Lock className="w-3.5 h-3.5" />
              </span>
            ) : (
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full bg-[var(--macro-protein)] boot-dot"
                  style={{ "--boot-dot-delay": "90ms" } as React.CSSProperties}
                />
                <span
                  className="w-2 h-2 rounded-full bg-[var(--macro-fat)] boot-dot"
                  style={{ "--boot-dot-delay": "170ms" } as React.CSSProperties}
                />
                <span
                  className="w-2 h-2 rounded-full bg-[var(--macro-carbs)] boot-dot"
                  style={{ "--boot-dot-delay": "250ms" } as React.CSSProperties}
                />
              </div>
            )}
          </div>
        </div>

        {/* Brand Wordmark + Live Status Pill */}
        <div className="flex flex-col items-center gap-2 text-center boot-copy-enter">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            openCalory
          </span>
          <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full surface-glass-pill text-xs font-medium text-muted-foreground tabular-nums">
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${
                isConfirmed
                  ? "bg-[var(--macro-carbs)]"
                  : isLocked
                    ? "bg-[var(--neutral-over)]"
                    : "bg-[var(--macro-calories)] boot-pulse-dot"
              }`}
            />
            <span>{statusLabel}</span>
          </span>
        </div>

        {/* Locked Cloud Sync Passphrase Gate (blocks all routes until unlocked) */}
        {isLocked && (
          <div
            data-testid="boot-sync-gate-card"
            className="w-full surface-elevated-sheet rounded-3xl p-5 space-y-3.5 animate-modal-in"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-[var(--macro-calories)]/15 border border-[var(--macro-calories)]/25 flex items-center justify-center text-[var(--macro-calories)] shrink-0">
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-bold text-foreground tracking-tight">
                  Cloud Sync Passphrase Required
                </h1>
                <p className="text-[11px] text-muted-foreground">
                  Verify access to load your nutrition workspace
                </p>
              </div>
            </div>

            <SyncUnlockCard compact onUnlocked={onUnlocked} />
          </div>
        )}
      </div>
    </div>
  );
}
