"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { ThemeSwitcher } from "@/components/theme/theme-switcher";
import { BackupPanel } from "@/components/settings/backup-panel";
import { GoalsCalculatorForm } from "@/components/settings/goals-calculator-form";
import { AiHealthStatusCard } from "@/components/settings/ai-health-status-card";
import { CentralDbStatusCard } from "@/components/settings/central-db-status-card";
import { FoodCatalogCard } from "@/components/settings/food-catalog-card";
import { AppleHealthShortcutCard } from "@/components/settings/apple-health-shortcut-card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  PageStagger,
  ScrollReveal,
  StaggerItem,
} from "@/components/motion/motion-primitives";
import { triggerHaptic } from "@/lib/motion";
import { ArrowLeft, Moon, ShieldCheck, Database } from "lucide-react";

type SettingsSectionTab = "targets" | "integrations" | "data";

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsSectionTab>("targets");

  const handleBack = (e: React.MouseEvent<HTMLAnchorElement>) => {
    triggerHaptic(8);
    if (typeof window !== "undefined" && window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
  };

  return (
    <AppShell>
      <PageStagger className="flex flex-col gap-4 sm:gap-5 px-4 sm:px-6 lg:px-8 pt-3 sm:pt-6 pb-8">
        {/* Compact Header matching Dashboard Obsidian Aesthetic */}
        <StaggerItem>
        <header className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <Link
              href="/"
              onClick={handleBack}
              aria-label="Back to previous page"
              className="touch-target lg:hidden inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full liquid-pill-glass text-xs font-semibold text-foreground"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Back</span>
            </Link>
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
              Settings &amp; Preferences
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
              Targets, appearance, AI vision health &amp; local database backups
            </p>
          </div>
        </header>
        </StaggerItem>

        {/* Mobile & Tablet Segmented Section Switcher (eliminates 3.7x VH vertical scroll) */}
        <StaggerItem className="lg:hidden">
          <SegmentedControl<SettingsSectionTab>
            role="tablist"
            ariaLabel="Settings sections"
            value={activeTab}
            onChange={(next) => {
              triggerHaptic(6);
              setActiveTab(next);
            }}
            className="w-full bg-card border border-border/50 p-1"
            buttonClassName="flex-1 text-xs py-2"
            options={[
              { value: "targets", label: "Targets" },
              { value: "integrations", label: "Sync & AI" },
              { value: "data", label: "Data & Theme" },
            ]}
          />
        </StaggerItem>

        {/* Responsive 12-Column Obsidian Bento Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 lg:gap-6 items-start">
          {/* Left Column: Goals & TDEE Calculator */}
          <StaggerItem
            className={`lg:col-span-7 space-y-4 sm:space-y-5 ${
              activeTab === "targets" ? "block" : "hidden lg:block"
            }`}
          >
            <GoalsCalculatorForm />

            {/* Compact Principles Footer Disclosure (replaces two heavy manifesto cards) */}
            <div className="rounded-2xl bg-surface-sub/45 border border-border/40 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 text-xs text-muted-foreground">
              <div className="flex items-start gap-2 flex-1 min-w-0">
                <ShieldCheck
                  className="w-4 h-4 text-foreground/80 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span>
                  <strong className="text-foreground font-semibold">
                    Adherence-Neutral Analytics:
                  </strong>{" "}
                  Surplus intake stays neutral scientific telemetry—never red alerts.
                </span>
              </div>
              <div className="flex items-start gap-2 flex-1 min-w-0 sm:border-l sm:border-border/50 sm:pl-3">
                <Database
                  className="w-4 h-4 text-foreground/80 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span>
                  <strong className="text-foreground font-semibold">
                    Offline Storage &amp; Privacy:
                  </strong>{" "}
                  100% stored on-device in IndexedDB with optional cloud sync.
                </span>
              </div>
            </div>
          </StaggerItem>

          {/* Right Column: Appearance, Sync, AI Vision & Backup */}
          <ScrollReveal
            className={`lg:col-span-5 lg:sticky lg:top-[max(1.5rem,env(safe-area-inset-top))] grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4 sm:gap-5 items-start ${
              activeTab === "targets" ? "hidden lg:grid" : "grid"
            }`}
          >
            {/* Theme Section */}
            <section
              className={`bg-card border border-border/50 rounded-2xl p-4 sm:p-5 space-y-3 md:col-span-2 lg:col-span-1 ${
                activeTab === "data" ? "block" : "hidden lg:block"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-full liquid-pill-glass flex items-center justify-center text-foreground shrink-0">
                    <Moon className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-foreground tracking-tight">
                      Theme &amp; Appearance
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Dark, light, or match system
                    </p>
                  </div>
                </div>
                <ThemeSwitcher />
              </div>
            </section>

            {/* Central Database Sync */}
            <div className={activeTab === "integrations" ? "block" : "hidden lg:block"}>
              <CentralDbStatusCard />
            </div>

            {/* AI Vision & OCR Service */}
            <div className={activeTab === "integrations" ? "block" : "hidden lg:block"}>
              <AiHealthStatusCard />
            </div>

            {/* Apple Health iOS Shortcut Bridge */}
            <div
              className={`md:col-span-2 lg:col-span-1 ${
                activeTab === "integrations" ? "block" : "hidden lg:block"
              }`}
            >
              <AppleHealthShortcutCard />
            </div>

            {/* Food Database Catalog, Importer & ODbL Attribution */}
            <div
              className={`md:col-span-2 lg:col-span-1 ${
                activeTab === "data" ? "block" : "hidden lg:block"
              }`}
            >
              <FoodCatalogCard />
            </div>

            {/* Data Backup & Restore */}
            <div
              className={`md:col-span-2 lg:col-span-1 ${
                activeTab === "data" ? "block" : "hidden lg:block"
              }`}
            >
              <BackupPanel />
            </div>
          </ScrollReveal>
        </div>
      </PageStagger>
    </AppShell>
  );
}
