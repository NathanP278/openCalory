"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { BootSplashOverlay, type BootOverlayMode } from "./boot-splash-overlay";
import { useLoggerStore } from "@/stores/logger-store";
import { db } from "@/lib/db/opencalory-db";
import { isCloudSyncEnabled, syncWithCentralDb } from "@/lib/db/cloud-sync";

type BootPhase = "checking" | "locked" | "confirmed" | "revealing" | "ready";

export interface AppBootGateProps {
  children: React.ReactNode;
  /** Testing hook to run the boot gate inside jsdom unit tests. */
  forceGate?: boolean;
}

function isJsdomEnvironment(): boolean {
  return typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
}

/**
 * Root-level boot & Cloud Sync access gate.
 * Runs on every fresh app open / direct URL load across all routes so no page
 * content mounts until Cloud Sync access is verified, then reveals the page
 * with an authored dissolve transition.
 */
export function AppBootGate({ children, forceGate = false }: AppBootGateProps) {
  const bypassInTests = !forceGate && isJsdomEnvironment();
  const [phase, setPhase] = useState<BootPhase>(
    bypassInTests ? "ready" : "checking"
  );
  const [statusLabel, setStatusLabel] = useState("Checking Cloud Sync...");
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const isMountedRef = useRef(true);

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      if (isMountedRef.current) fn();
    }, ms);
    timersRef.current.push(id);
    return id;
  }, []);

  const prefersReducedMotion = useCallback(() => {
    return (
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
    );
  }, []);

  const revealApp = useCallback(
    (confirmedLabel: string) => {
      const reduced = prefersReducedMotion();
      setStatusLabel(confirmedLabel);
      setPhase("confirmed");

      const confirmBeatMs = reduced ? 60 : 240;
      const dissolveMs = reduced ? 130 : 440;

      scheduleTimer(() => {
        setPhase("revealing");
        scheduleTimer(() => {
          setPhase("ready");
        }, dissolveMs);
      }, confirmBeatMs);
    },
    [prefersReducedMotion, scheduleTimer]
  );

  useEffect(() => {
    isMountedRef.current = true;
    const timers = timersRef.current;
    if (bypassInTests) {
      return () => {
        isMountedRef.current = false;
      };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = scheduleTimer(() => controller.abort(), 3000);

    async function verifyAccess() {
      const reduced = prefersReducedMotion();
      const minProminentMs = reduced ? 100 : 560;

      const waitMinHold = async () => {
        const remaining = Math.max(0, minProminentMs - (Date.now() - startedAt));
        if (remaining > 0) {
          await new Promise<void>((resolve) => {
            scheduleTimer(resolve, remaining);
          });
        }
      };

      // If browser is offline, allow local-first offline access after prominent intro beat
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await waitMinHold();
        if (!isMountedRef.current) return;
        revealApp("Offline Â· Local Mode");
        return;
      }

      try {
        const res = await fetch("/api/auth/sync-session", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          // Server error or unavailable -> allow local-first access
          await waitMinHold();
          if (!isMountedRef.current) return;
          revealApp("Local Workspace Ready");
          return;
        }

        const data = (await res.json()) as {
          authRequired?: boolean;
          authenticated?: boolean;
        };

        await waitMinHold();
        if (!isMountedRef.current) return;

        if (data.authRequired && !data.authenticated) {
          useLoggerStore.getState().setSyncAuthLocked(true);
          setStatusLabel("Passphrase Required");
          setPhase("locked");
          return;
        }

        useLoggerStore.getState().setSyncAuthLocked(false);
        revealApp(data.authRequired ? "Cloud Sync Verified" : "Ready");
      } catch {
        clearTimeout(timeoutId);
        await waitMinHold();
        if (!isMountedRef.current) return;
        // Network unreachable / timeout -> offline-first local mode
        revealApp("Offline Â· Local Mode");
      }
    }

    void verifyAccess();

    return () => {
      isMountedRef.current = false;
      controller.abort();
      for (const t of timers) {
        clearTimeout(t);
      }
      timers.length = 0;
    };
  }, [bypassInTests, prefersReducedMotion, revealApp, scheduleTimer]);

  const handleUnlocked = useCallback(() => {
    useLoggerStore.getState().setSyncAuthLocked(false);
    if (isCloudSyncEnabled()) {
      void syncWithCentralDb(db).catch(() => {});
    }
    revealApp("Cloud Sync Verified");
  }, [revealApp]);

  const shouldRenderPage = phase === "revealing" || phase === "ready";
  const overlayVisible = phase !== "ready";
  const overlayExiting = phase === "revealing";
  const overlayMode: BootOverlayMode =
    phase === "locked"
      ? "locked"
      : phase === "confirmed" || phase === "revealing"
        ? "confirmed"
        : "checking";

  return (
    <>
      <BootSplashOverlay
        visible={overlayVisible}
        exiting={overlayExiting}
        statusLabel={statusLabel}
        mode={overlayMode}
        onUnlocked={handleUnlocked}
      />
      {shouldRenderPage ? (
        <div
          data-testid="app-boot-content"
          className={
            phase === "revealing"
              ? "min-h-dvh flex flex-col flex-1 boot-page-reveal"
              : "min-h-dvh flex flex-col flex-1"
          }
        >
          {children}
        </div>
      ) : null}
    </>
  );
}
