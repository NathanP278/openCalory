'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import {
  getCatalogSyncState,
  initClientCatalog,
  subscribeCatalogSync,
  type CatalogSyncState,
} from '@/lib/foods/client-catalog';
import { parseFoodCsv, parseFoodJson } from '@/lib/foods/csv-food-parser';

interface ImportFeedback {
  importedCount: number;
  errors: string[];
  fatalError?: string;
}

function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function isJsonFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  const lowerType = (file.type || '').toLowerCase();
  return lowerName.endsWith('.json') || lowerType === 'application/json';
}

interface FoodCatalogCardProps {
  className?: string;
}

export function FoodCatalogCard({ className }: FoodCatalogCardProps) {
  const [catalogState, setCatalogState] = useState<CatalogSyncState>(() =>
    getCatalogSyncState()
  );
  const [isImporting, setIsImporting] = useState(false);
  const [feedback, setFeedback] = useState<ImportFeedback | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = subscribeCatalogSync((next) => {
      setCatalogState(next);
    });
    initClientCatalog();
    return () => {
      unsubscribe();
    };
  }, []);

  const tierLabel = (() => {
    if (catalogState.tier === 'expanded') return 'Expanded';
    if (catalogState.tier === 'core') return 'Core';
    return '—';
  })();

  const foodCountLabel =
    typeof catalogState.foodCount === 'number'
      ? catalogState.foodCount.toLocaleString()
      : '—';

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setFeedback(null);

    try {
      const text = await readFileAsText(file);
      const parsed = isJsonFile(file)
        ? parseFoodJson(text, { defaultSource: 'custom_food' })
        : parseFoodCsv(text, { defaultSource: 'custom_food' });

      const itemsToStore = parsed.items.map((item) => ({
        ...item,
        source: 'custom_food' as const,
      }));

      if (itemsToStore.length > 0) {
        await db.foodsCache.bulkPut(itemsToStore);
      }

      setFeedback({
        importedCount: itemsToStore.length,
        errors: parsed.errors,
      });
    } catch (err) {
      setFeedback({
        importedCount: 0,
        errors: [],
        fatalError:
          err instanceof Error ? err.message : 'Failed to import food table',
      });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const visibleErrors = feedback?.errors.slice(0, 10) ?? [];
  const remainingErrors =
    (feedback?.errors.length ?? 0) - visibleErrors.length;

  return (
    <section
      className={`bg-card border border-border/50 rounded-2xl p-4 sm:p-5 space-y-3.5 ${
        className || ''
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-2xl bg-[var(--macro-calories)]/15 flex items-center justify-center text-[var(--macro-calories)] shrink-0">
          <Database className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground tracking-tight">
            Food Database Catalog
          </h2>
          <p className="text-xs text-muted-foreground">
            Offline SQLite FTS5 catalog, CSV/JSON food importer &amp; licenses
          </p>
        </div>
      </div>

      {/* Catalog Status */}
      <div className="bg-surface-sub rounded-xl p-3 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Offline Status:</span>
          {catalogState.status === 'ready' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--macro-carbs)] text-right">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Offline Ready (OPFS)</span>
            </span>
          )}
          {catalogState.status === 'syncing' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-foreground text-right">
              <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
              <span>
                Syncing...
                {typeof catalogState.progressPct === 'number'
                  ? ` (${Math.round(catalogState.progressPct)}%)`
                  : ''}
              </span>
            </span>
          )}
          {catalogState.status === 'fallback' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--neutral-over)] text-right">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Server Fallback</span>
            </span>
          )}
          {catalogState.status === 'idle' && (
            <span className="text-[11px] text-muted-foreground">Initializing...</span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="bg-card rounded-lg px-2.5 py-1.5 text-center">
            <div className="text-[10px] text-muted-foreground">Catalog Tier</div>
            <div className="text-xs font-semibold text-foreground">{tierLabel}</div>
          </div>
          <div className="bg-card rounded-lg px-2.5 py-1.5 text-center">
            <div className="text-[10px] text-muted-foreground">Indexed Foods</div>
            <div className="text-xs font-semibold tabular-nums text-foreground">
              {foodCountLabel}
            </div>
          </div>
        </div>

        {catalogState.status === 'fallback' && catalogState.reason && (
          <div className="pt-1 text-[11px] text-[var(--neutral-over)] bg-card p-2.5 rounded-xl leading-relaxed">
            {catalogState.reason}
          </div>
        )}
      </div>

      {/* CSV / JSON Food Importer */}
      <div className="bg-surface-sub rounded-xl p-3 space-y-2.5">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-foreground">
            Import Custom Foods (CSV / JSON)
          </div>
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            Upload a <code className="font-mono text-[10px]">.csv</code> or{' '}
            <code className="font-mono text-[10px]">.json</code> food table
            (required fields: <code className="font-mono text-[10px]">name, calories, protein, carbs, fat</code>)
            to save directly into your local food cache.
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          data-testid="food-catalog-file-input"
          aria-label="Import food table CSV or JSON"
          onChange={(e) => void handleFileSelect(e)}
          className="hidden"
        />

        <button
          type="button"
          onClick={triggerFileInput}
          disabled={isImporting}
          className="touch-target tactile-press w-full bg-card hover:bg-surface-elevated border border-border/50 text-foreground font-semibold px-3.5 py-2 rounded-full text-xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <Upload className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
          <span>{isImporting ? 'Importing...' : 'Import CSV / JSON Food Table'}</span>
        </button>

        {feedback && (
          <div className="space-y-2">
            {feedback.importedCount > 0 && (
              <div className="p-2.5 rounded-xl flex items-center gap-2 text-xs bg-[var(--macro-carbs)]/15 text-[var(--macro-carbs)]">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  Imported {feedback.importedCount}{' '}
                  {feedback.importedCount === 1 ? 'food' : 'foods'} into your local
                  food cache.
                </span>
              </div>
            )}

            {feedback.importedCount === 0 &&
              !feedback.fatalError &&
              visibleErrors.length === 0 && (
                <div className="p-2.5 rounded-xl flex items-center gap-2 text-xs bg-card text-muted-foreground">
                  <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>No foods found in file.</span>
                </div>
              )}

            {feedback.fatalError && (
              <div className="p-2.5 rounded-xl flex items-start gap-2 text-xs bg-card text-[var(--neutral-over)]">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{feedback.fatalError}</span>
              </div>
            )}

            {visibleErrors.length > 0 && (
              <div className="p-2.5 rounded-xl bg-card text-[11px] text-[var(--neutral-over)] space-y-1">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {feedback.errors.length}{' '}
                    {feedback.errors.length === 1 ? 'row skipped' : 'rows skipped'} due
                    to validation errors:
                  </span>
                </div>
                <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
                  {visibleErrors.map((err, idx) => (
                    <li key={`${idx}-${err}`}>{err}</li>
                  ))}
                  {remainingErrors > 0 && (
                    <li>and {remainingErrors} more validation error(s).</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Data Sources & Licenses (ODbL-1.0) */}
      <div className="rounded-xl bg-surface-sub/60 border border-border/50 p-3 space-y-1.5 text-[11px] text-muted-foreground leading-relaxed">
        <div className="flex items-center gap-1.5 font-semibold text-foreground">
          <BookOpen
            className="w-3.5 h-3.5 text-[var(--macro-carbs)] shrink-0"
            aria-hidden="true"
          />
          <span>Data Sources &amp; Licenses (ODbL-1.0)</span>
        </div>
        <p>
          Compiled <code className="font-mono text-[10px] text-foreground">food-catalog.db</code>{' '}
          artifacts combine open nutrition databases including{' '}
          <strong className="text-foreground">Open Food Facts</strong> (ODbL-1.0),{' '}
          <strong className="text-foreground">OpenNutrition</strong> (ODbL-1.0),{' '}
          <strong className="text-foreground">FoodRepo</strong> (CC BY 4.0), and open
          national food composition tables (USDA FoodData Central, BLS 4.0, CNF, CoFID,
          AUSNUT, MEXT, Ciqual, NEVO, Frida, Livsmedelsverket, TBCA/TACO, and Anuvaad
          INDB).
        </p>
        <p>
          The compiled database artifact is distributed under{' '}
          <strong className="text-foreground">ODbL-1.0</strong> while the application
          source code retains its repository license (MIT). See{' '}
          <code className="font-mono text-[10px] text-foreground">DATA_LICENSES.md</code>{' '}
          for full dataset attributions.
        </p>
      </div>
    </section>
  );
}
