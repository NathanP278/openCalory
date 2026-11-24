"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Download,
  Upload,
  AlertCircle,
  CheckCircle2,
  Database,
  ShieldAlert,
  FileSpreadsheet,
  X,
} from "lucide-react";
import { exportBackupJson, importBackupJson } from "@/lib/db/backup";
import {
  buildFoodLogsCsv,
  buildDailySummaryCsv,
  buildWeightLogsCsv,
} from "@/lib/db/csv-export";
import { db } from "@/lib/db/opencalory-db";
import { DEFAULT_RDA_MICROS } from "@/lib/nutrition/goals";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { triggerHaptic } from "@/lib/motion";
import type { UserGoals } from "@/types/nutrition";

type CsvExportKind = "food-logs" | "daily-summary" | "weight-logs";

const FALLBACK_USER_GOALS: UserGoals = {
  id: "active",
  dailyCalories: 2000,
  proteinG: 150,
  carbsG: 200,
  fatG: 65,
  fiberG: 30,
  micronutrientTargets: { ...DEFAULT_RDA_MICROS },
  mealSlots: [],
  updatedAt: 0,
};

function downloadTextFile(
  content: string,
  filename: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface CsvExportOption {
  kind: CsvExportKind;
  label: string;
  filenamePrefix: string;
  successMessage: string;
  build: () => Promise<string>;
}

const CSV_EXPORT_OPTIONS: CsvExportOption[] = [
  {
    kind: "food-logs",
    label: "Food Logs CSV",
    filenamePrefix: "opencalory-food-logs",
    successMessage: "Food Logs CSV exported!",
    build: async () => {
      const logs = await db.foodLogs.toArray();
      return buildFoodLogsCsv(logs);
    },
  },
  {
    kind: "daily-summary",
    label: "Daily Summary CSV",
    filenamePrefix: "opencalory-daily-summary",
    successMessage: "Daily Summary CSV exported!",
    build: async () => {
      const [logs, goals] = await Promise.all([
        db.foodLogs.toArray(),
        db.userGoals.get("active"),
      ]);
      return buildDailySummaryCsv(logs, goals ?? FALLBACK_USER_GOALS);
    },
  },
  {
    kind: "weight-logs",
    label: "Weigh-Ins CSV",
    filenamePrefix: "opencalory-weigh-ins",
    successMessage: "Weigh-Ins CSV exported!",
    build: async () => {
      const weights = await db.weightLogs.toArray();
      return buildWeightLogsCsv(weights);
    },
  },
];

interface BackupPanelProps {
  className?: string;
}

export function BackupPanel({ className }: BackupPanelProps) {
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [isExporting, setIsExporting] = useState(false);
  const [exportingCsvKind, setExportingCsvKind] = useState<CsvExportKind | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<"success" | "error" | null>(null);
  const [pendingReplaceFile, setPendingReplaceFile] = useState<File | null>(null);
  const [localRecordCounts, setLocalRecordCounts] = useState<{
    foodLogs: number;
    customRecipes: number;
    weightLogs: number;
    foodsCache: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pendingReplaceFile) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPendingReplaceFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingReplaceFile]);

  const readFileAsText = (file: File): Promise<string> => {
    if (typeof file.text === "function") {
      return file.text();
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  };

  const handleExport = async () => {
    try {
      setIsExporting(true);
      setStatusMessage(null);
      setStatusType(null);

      const json = await exportBackupJson();
      const timestamp = new Date().toISOString().slice(0, 10);
      downloadTextFile(
        json,
        `opencalory-backup-${timestamp}.json`,
        "application/json"
      );

      setStatusType("success");
      setStatusMessage("Backup exported successfully!");
    } catch (err) {
      setStatusType("error");
      setStatusMessage(err instanceof Error ? err.message : "Failed to export backup");
    } finally {
      setIsExporting(false);
    }
  };

  const handleCsvExport = async (option: CsvExportOption) => {
    try {
      setExportingCsvKind(option.kind);
      setStatusMessage(null);
      setStatusType(null);
      triggerHaptic(8);

      const csv = await option.build();
      const timestamp = new Date().toISOString().slice(0, 10);
      downloadTextFile(
        csv,
        `${option.filenamePrefix}-${timestamp}.csv`,
        "text/csv;charset=utf-8"
      );

      setStatusType("success");
      setStatusMessage(option.successMessage);
    } catch (err) {
      setStatusType("error");
      setStatusMessage(err instanceof Error ? err.message : "Failed to export CSV");
    } finally {
      setExportingCsvKind(null);
    }
  };

  const executeImportFile = async (file: File, mode: "merge" | "replace") => {
    try {
      setIsImporting(true);
      setStatusMessage(null);
      setStatusType(null);

      const text = await readFileAsText(file);
      const result = await importBackupJson(text, mode);

      const counts = result.importedCounts;
      const parts = [
        `${counts.foodLogs} log${counts.foodLogs === 1 ? "" : "s"}`,
        `${counts.foodsCache} food${counts.foodsCache === 1 ? "" : "s"}`,
        `${counts.customRecipes} recipe${counts.customRecipes === 1 ? "" : "s"}`,
        `${counts.userGoals} goal${counts.userGoals === 1 ? "" : "s"}`,
      ];
      if (typeof counts.weightLogs === "number") {
        parts.push(`${counts.weightLogs} weigh-in${counts.weightLogs === 1 ? "" : "s"}`);
      }
      if (typeof counts.pinnedFoods === "number") {
        parts.push(`${counts.pinnedFoods} pinned`);
      }

      setStatusType("success");
      const syncNote = result.syncPending
        ? " (cloud replace queued until unlock/reconnect)"
        : "";
      setStatusMessage(`Imported: ${parts.join(", ")}${syncNote}`);
    } catch (err) {
      setStatusType("error");
      setStatusMessage(err instanceof Error ? err.message : "Failed to import backup");
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (importMode === "replace") {
      try {
        const [foodLogs, customRecipes, weightLogs, foodsCache] = await Promise.all([
          db.foodLogs.count(),
          db.customRecipes.count(),
          db.weightLogs.count(),
          db.foodsCache.count(),
        ]);
        setLocalRecordCounts({ foodLogs, customRecipes, weightLogs, foodsCache });
      } catch {
        setLocalRecordCounts(null);
      }
      setPendingReplaceFile(file);
      return;
    }

    await executeImportFile(file, "merge");
  };

  const handleCancelReplace = () => {
    setPendingReplaceFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleConfirmReplace = async () => {
    const file = pendingReplaceFile;
    setPendingReplaceFile(null);
    if (!file) return;
    await executeImportFile(file, "replace");
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <section className={`bg-card border border-border/50 rounded-2xl p-4 sm:p-5 space-y-4 ${className || ""}`}>
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-2xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)] shrink-0">
          <Database className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground tracking-tight">Data Backup & Restore</h2>
          <p className="text-xs text-muted-foreground">Versioned JSON backup, CSV exports & atomic import</p>
        </div>
      </div>

      {/* Export JSON Section */}
      <div className="bg-surface-sub rounded-xl p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-foreground">Export Backup</div>
          <div className="text-[11px] text-muted-foreground">
            Download a portable v2 snapshot of logs, foods, recipes, weigh-ins, pins, and goals
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting || exportingCsvKind !== null}
          className="touch-target tactile-press w-full sm:w-auto justify-center bg-foreground text-background hover:opacity-90 font-semibold px-3.5 py-2 rounded-full text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0 shadow-xs"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{isExporting ? "Exporting..." : "Export Backup"}</span>
        </button>
      </div>

      {/* Export CSV Section */}
      <div className="bg-surface-sub rounded-xl p-3 space-y-2.5">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-foreground">Export CSV</div>
          <div className="text-[11px] text-muted-foreground">
            Formula-safe spreadsheet downloads for food entries, daily summaries, and weigh-ins
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {CSV_EXPORT_OPTIONS.map((option) => {
            const isBusy = exportingCsvKind === option.kind;
            return (
              <button
                key={option.kind}
                type="button"
                onClick={() => void handleCsvExport(option)}
                disabled={isExporting || exportingCsvKind !== null}
                className="touch-target tactile-press w-full bg-card hover:bg-surface-elevated border border-border/50 text-foreground font-semibold px-3 py-2 rounded-full text-xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                <span className="truncate">{isBusy ? "Exporting..." : option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Import Section */}
      <div className="bg-surface-sub rounded-xl p-3 space-y-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold text-foreground">Import Backup</div>
            <div className="text-[11px] text-muted-foreground">
              Restore data from a valid <code className="font-mono text-[10px]">opencalory-backup.json</code> file
            </div>
          </div>

          {/* Mode Selector */}
          <SegmentedControl<"merge" | "replace">
            role="group"
            ariaLabel="Backup import mode"
            value={importMode}
            onChange={(next) => {
              triggerHaptic(6);
              setImportMode(next);
            }}
            className="bg-card p-0.5 text-xs shrink-0"
            buttonClassName="px-3 py-1.5 text-[11px] cursor-pointer"
            options={[
              { value: "merge", label: "Merge" },
              {
                value: "replace",
                label: "Replace",
                activeThumbClassName: "bg-[var(--neutral-over)]",
              },
            ]}
          />
        </div>

        {importMode === "replace" && (
          <div className="flex items-start gap-2 p-2.5 rounded-xl bg-card text-[var(--neutral-over)] text-[11px]">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <strong className="text-foreground">Replace mode:</strong> Wipes all local nutrition logs, custom recipes, and user goals before restoring.
            </div>
          </div>
        )}

        {importMode === "merge" && (
          <div className="text-[11px] text-muted-foreground">
            <strong className="text-foreground">Merge mode:</strong> Safely upserts logs and recipes by ID, and resolves user goals by updatedAt timestamp.
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          data-testid="backup-file-input"
          onChange={handleFileSelect}
          className="hidden"
        />

        <button
          type="button"
          onClick={triggerFileInput}
          disabled={isImporting}
          className="macro-spring active:scale-95 w-full bg-card hover:bg-surface-elevated text-foreground font-semibold px-3.5 py-2 rounded-full text-xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <Upload className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
          <span>{isImporting ? "Importing..." : `Select JSON File to ${importMode === "replace" ? "Replace" : "Merge"}`}</span>
        </button>
      </div>

      {/* Status Messages */}
      {statusMessage && (
        <div
          className={`p-2.5 rounded-xl flex items-center gap-2 text-xs ${
            statusType === "success"
              ? "bg-[var(--macro-carbs)]/15 text-[var(--macro-carbs)] animate-check-pop"
              : "bg-surface-sub text-[var(--neutral-over)]"
          }`}
        >
          {statusType === "success" ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          )}
          <span className="leading-snug">{statusMessage}</span>
        </div>
      )}
      {/* Replace Confirmation Modal */}
      {pendingReplaceFile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm replace backup import"
          data-testid="replace-confirm-modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/72 animate-backdrop-in"
          onClick={handleCancelReplace}
        >
          <div
            className="w-full max-w-md surface-elevated-sheet rounded-3xl p-5 space-y-4 animate-modal-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-2xl bg-[var(--neutral-over)]/15 flex items-center justify-center text-[var(--neutral-over)] shrink-0">
                  <ShieldAlert className="w-4 h-4" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground">
                    Replace all local data?
                  </h3>
                  <p className="text-[11px] text-muted-foreground truncate max-w-[240px]">
                    {pendingReplaceFile.name}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancelReplace}
                aria-label="Cancel replace import"
                className="touch-target tactile-press p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-sub"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              This will permanently wipe your current local records before restoring from the selected backup file.
            </p>

            {localRecordCounts && (
              <div className="grid grid-cols-2 gap-2 p-3 rounded-2xl bg-surface-sub border border-border/50 text-xs tabular-nums">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Food logs</span>
                  <strong className="text-foreground">{localRecordCounts.foodLogs.toLocaleString()}</strong>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Weigh-ins</span>
                  <strong className="text-foreground">{localRecordCounts.weightLogs.toLocaleString()}</strong>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Recipes</span>
                  <strong className="text-foreground">{localRecordCounts.customRecipes.toLocaleString()}</strong>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Saved foods</span>
                  <strong className="text-foreground">{localRecordCounts.foodsCache.toLocaleString()}</strong>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={handleCancelReplace}
                className="touch-target tactile-press px-4 py-2 rounded-full bg-surface-sub border border-border text-xs font-semibold text-foreground hover:bg-surface-elevated"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmReplace()}
                className="touch-target tactile-press px-4 py-2 rounded-full bg-foreground text-background text-xs font-semibold hover:opacity-90"
              >
                Replace All Data
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
