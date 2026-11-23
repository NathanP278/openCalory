'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import { getTodayIsoDate } from '@/stores/logger-store';
import { KG_TO_LB } from '@/components/weight/weigh-in-drawer';
import { triggerHaptic } from '@/lib/motion';

export function AppleHealthShortcutCard() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [copiedField, setCopiedField] = useState<'url' | 'header' | 'steps' | null>(
    null
  );
  const [origin, setOrigin] = useState('https://your-opencalory.vercel.app');

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      setOrigin(window.location.origin);
    }
  }, []);

  const endpointUrl = `${origin}/api/weight/latest?tz=Asia/Manila`;
  const authHeaderSnippet = 'Authorization: Bearer YOUR_SHORTCUT_API_KEY';

  const latestEntry = useLiveQuery(async () => {
    const all = await db.weightLogs.toArray();
    if (all.length === 0) return null;
    all.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      if (a.recordedAt !== b.recordedAt) {
        return b.recordedAt.localeCompare(a.recordedAt);
      }
      return b.createdAt - a.createdAt;
    });
    return all[0] ?? null;
  }, []);

  const checkShortcutStatus = useCallback(async () => {
    setIsChecking(true);
    try {
      const res = await fetch('/api/weight/status', {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          configured?: boolean;
          connected?: boolean;
          lastSyncedAt?: string | null;
        };
        setConfigured(Boolean(data.configured));
        setConnected(Boolean(data.connected));
        setLastSyncedAt(data.lastSyncedAt ?? null);
      } else {
        setConfigured(false);
        setConnected(false);
        setLastSyncedAt(null);
      }
    } catch {
      setConfigured(false);
      setConnected(false);
      setLastSyncedAt(null);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void checkShortcutStatus();
    }, 0);
    return () => clearTimeout(timer);
  }, [checkShortcutStatus]);

  const handleCopy = async (
    field: 'url' | 'header' | 'steps',
    text: string
  ) => {
    triggerHaptic(8);
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard API may be unavailable in test/insecure contexts
    }
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((prev) => (prev === field ? null : prev));
    }, 1800);
  };

  const fallbackDate = getTodayIsoDate();
  const previewPayload = latestEntry
    ? {
        id: latestEntry.id,
        date: latestEntry.date,
        weight_kg: Number(latestEntry.weightKg.toFixed(2)),
        weight_lb: Number((latestEntry.weightKg * KG_TO_LB).toFixed(2)),
        recorded_at: latestEntry.recordedAt,
      }
    : {
        id: 'w_example_01',
        date: fallbackDate,
        weight_kg: 76.5,
        weight_lb: 168.65,
        recorded_at: `${fallbackDate}T08:00:00.000Z`,
      };

  const shortcutStepsText = [
    `1. Get Contents of URL: Call GET ${endpointUrl} with header ${authHeaderSnippet}.`,
    `2. Get Dictionary Value & Validate:\n   - Get Value for "id" in Contents of URL.\n   - Get Value for "weight_kg" in Contents of URL.\n   - If "weight_kg" (Dictionary Value) is less than or equal to 0 -> Stop this shortcut. (Also verify "id" has a value if no entry exists today.)\n   - End If`,
    `3. Parse Date & Check Deduplication File:\n   - Get Value for "recorded_at" in Contents of URL.\n   - Get dates from "recorded_at" (Dictionary Value).\n   - Get file from Shortcuts at path "opencalory-last-weight-id.txt" (with Error If Not Found turned off).`,
    `4. Log Health Sample & Save ID:\n   - If File is not "id" (Dictionary Value):\n     - Log Health Sample: Type = Weight, Value = "weight_kg" (Dictionary Value) kg, Date = Dates.\n     - Text: Set to "id" (Dictionary Value).\n     - Save Text to Shortcuts (path: "opencalory-last-weight-id.txt", with Overwrite If File Already Exists turned on).\n   - End If`,
    `5. Automate Daily Sync: Open the Automation tab in Shortcuts -> tap + -> Time of Day -> set your preferred daily sync time (e.g., 11:30 PM), select Daily and Run Immediately -> tap Next and choose your shortcut (Run Shortcut -> select the shortcut you built).`,
  ].join('\n\n');

  return (
    <section
      aria-label="Apple Health iOS Shortcut"
      className="bg-card border border-border/50 rounded-2xl p-4 sm:p-5 space-y-3.5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-2xl bg-[var(--macro-fiber)]/15 flex items-center justify-center text-[var(--macro-fiber)] shrink-0">
            <Smartphone className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground tracking-tight">
              Apple Health iOS Shortcut
            </h2>
            <p className="text-xs text-muted-foreground">
              Optional weigh-in sync to Apple Health via iOS Shortcuts
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void checkShortcutStatus()}
          disabled={isChecking}
          aria-label="Refresh shortcut API status"
          className="touch-target tactile-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-surface-sub text-foreground hover:bg-surface-elevated disabled:opacity-50 shrink-0"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>{isChecking ? 'Checking...' : 'Check Status'}</span>
        </button>
      </div>

      {/* Server Key Status & Collapsible Setup Guide */}
      <details className="group rounded-xl bg-surface-sub/60 border border-border/50 p-3 space-y-2.5 text-xs">
        <summary className="cursor-pointer select-none list-none flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-foreground">Setup Guide &amp; Endpoint Details</span>
            {configured === true && connected ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--macro-carbs)]">
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Connected</span>
              </span>
            ) : configured === true ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Awaiting Shortcut Setup</span>
              </span>
            ) : configured === false ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--neutral-over)]">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Not Configured</span>
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">Checking...</span>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground group-open:hidden shrink-0">Show</span>
          <span className="text-[10px] text-muted-foreground hidden group-open:inline shrink-0">Hide</span>
        </summary>

      <div className="bg-surface-sub rounded-xl p-3 space-y-2.5 text-xs mt-2.5">
        {configured === false && (
          <p className="text-[11px] text-[var(--neutral-over)]">
            Set <code className="font-mono text-[10px]">SHORTCUT_API_KEY</code> in your server environment variables to enable this endpoint.
          </p>
        )}
        {configured === true && !connected && (
          <p className="text-[11px] text-muted-foreground">
            Server API key is ready. Build and run your iOS Shortcut once to verify and mark this integration as <strong className="text-foreground font-medium">Connected</strong>.
          </p>
        )}
        {configured === true && connected && lastSyncedAt && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Last Shortcut Sync</span>
            <span className="font-mono text-[10px] text-foreground tabular-nums">
              {new Date(lastSyncedAt).toLocaleString()}
            </span>
          </div>
        )}

        {/* Endpoint URL */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Endpoint URL</span>
            <button
              type="button"
              onClick={() => void handleCopy('url', endpointUrl)}
              className="tactile-press inline-flex items-center gap-1 text-[11px] font-semibold text-foreground hover:opacity-80"
            >
              {copiedField === 'url' ? (
                <>
                  <Check className="w-3 h-3 text-[var(--macro-carbs)]" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" aria-hidden="true" />
                  <span>Copy URL</span>
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-[11px] text-foreground bg-card border border-border rounded-lg px-2.5 py-1.5 break-all">
            {endpointUrl}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Only returns weigh-ins logged for today&apos;s date (ignoring backfilled past entries). When no entry exists for today, returns{' '}
            <code className="font-mono text-[10px]">200 OK</code> with{' '}
            <code className="font-mono text-[10px]">&quot;id&quot;: null</code> so{' '}
            <em>If id has any value</em> cleanly skips logging.
          </p>
        </div>

        {/* Authorization Header */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Request Header</span>
            <button
              type="button"
              onClick={() => void handleCopy('header', authHeaderSnippet)}
              className="tactile-press inline-flex items-center gap-1 text-[11px] font-semibold text-foreground hover:opacity-80"
            >
              {copiedField === 'header' ? (
                <>
                  <Check className="w-3 h-3 text-[var(--macro-carbs)]" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" aria-hidden="true" />
                  <span>Copy Header</span>
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-[11px] text-foreground bg-card border border-border rounded-lg px-2.5 py-1.5 break-all">
            {authHeaderSnippet}
          </div>
        </div>
      </div>

      {/* Latest Weigh-In JSON Preview */}
      <div className="bg-surface-sub rounded-xl p-3 space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-semibold text-foreground">
            {latestEntry ? 'Latest Weigh-In JSON Preview' : 'Sample JSON Response'}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {previewPayload.weight_kg} kg &middot; {previewPayload.weight_lb} lb
          </span>
        </div>
        <pre className="font-mono text-[11px] tabular-nums text-foreground bg-card border border-border rounded-lg p-2.5 overflow-x-auto leading-relaxed">
          {JSON.stringify(previewPayload, null, 2)}
        </pre>
      </div>

      {/* 5-Step iOS Personal Automation Guide */}
      <div className="bg-surface-sub rounded-xl p-3 space-y-2.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-foreground">
            5-Step iOS Personal Automation Guide
          </span>
          <button
            type="button"
            onClick={() => void handleCopy('steps', shortcutStepsText)}
            className="tactile-press inline-flex items-center gap-1 text-[11px] font-semibold text-foreground hover:opacity-80"
          >
            {copiedField === 'steps' ? (
              <>
                <Check className="w-3 h-3 text-[var(--macro-carbs)]" aria-hidden="true" />
                <span>Copied Guide</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" aria-hidden="true" />
                <span>Copy Steps</span>
              </>
            )}
          </button>
        </div>
        <ol className="list-decimal list-inside space-y-2.5 text-[11px] text-muted-foreground leading-relaxed">
          <li>
            <span className="text-foreground font-medium">Get Contents of URL:</span>{' '}
            Call <code className="font-mono text-[10px]">GET {endpointUrl}</code> with header{' '}
            <code className="font-mono text-[10px]">Authorization: Bearer &lt;key&gt;</code>.
          </li>
          <li>
            <span className="text-foreground font-medium">Get Dictionary Value &amp; Validate:</span>
            <ul className="list-disc list-inside pl-3 mt-1 space-y-1">
              <li>
                Get Value for <code className="font-mono text-[10px]">id</code> in{' '}
                <code className="font-mono text-[10px]">Contents of URL</code>.
              </li>
              <li>
                Get Value for <code className="font-mono text-[10px]">weight_kg</code> in{' '}
                <code className="font-mono text-[10px]">Contents of URL</code>.
              </li>
              <li>
                <strong className="text-foreground font-medium">If</strong>{' '}
                <code className="font-mono text-[10px]">weight_kg</code> (
                <code className="font-mono text-[10px]">Dictionary Value</code>) is less than or equal to{' '}
                <code className="font-mono text-[10px]">0</code> &rarr;{' '}
                <strong className="text-foreground font-medium">Stop this shortcut</strong>. (Also verify{' '}
                <code className="font-mono text-[10px]">id</code> has a value if no entry exists today.)
              </li>
              <li>
                <strong className="text-foreground font-medium">End If</strong>
              </li>
            </ul>
          </li>
          <li>
            <span className="text-foreground font-medium">
              Parse Date &amp; Check Deduplication File:
            </span>
            <ul className="list-disc list-inside pl-3 mt-1 space-y-1">
              <li>
                Get Value for <code className="font-mono text-[10px]">recorded_at</code> in{' '}
                <code className="font-mono text-[10px]">Contents of URL</code>.
              </li>
              <li>
                <strong className="text-foreground font-medium">Get dates from</strong>{' '}
                <code className="font-mono text-[10px]">recorded_at</code> (
                <code className="font-mono text-[10px]">Dictionary Value</code>).
              </li>
              <li>
                <strong className="text-foreground font-medium">Get file from</strong>{' '}
                <code className="font-mono text-[10px]">Shortcuts</code> at path{' '}
                <code className="font-mono text-[10px]">opencalory-last-weight-id.txt</code> (with{' '}
                <em>Error If Not Found</em> turned off).
              </li>
            </ul>
          </li>
          <li>
            <span className="text-foreground font-medium">Log Health Sample &amp; Save ID:</span>
            <ul className="list-disc list-inside pl-3 mt-1 space-y-1">
              <li>
                <strong className="text-foreground font-medium">If</strong>{' '}
                <code className="font-mono text-[10px]">File</code> is not{' '}
                <code className="font-mono text-[10px]">id</code> (
                <code className="font-mono text-[10px]">Dictionary Value</code>):
                <ul className="list-disc list-inside pl-3.5 mt-1 space-y-1">
                  <li>
                    <strong className="text-foreground font-medium">Log Health Sample:</strong> Type ={' '}
                    <code className="font-mono text-[10px]">Weight</code>, Value ={' '}
                    <code className="font-mono text-[10px]">weight_kg</code> (
                    <code className="font-mono text-[10px]">Dictionary Value</code>){' '}
                    <code className="font-mono text-[10px]">kg</code>, Date ={' '}
                    <code className="font-mono text-[10px]">Dates</code>.
                  </li>
                  <li>
                    <strong className="text-foreground font-medium">Text:</strong> Set to{' '}
                    <code className="font-mono text-[10px]">id</code> (
                    <code className="font-mono text-[10px]">Dictionary Value</code>).
                  </li>
                  <li>
                    <strong className="text-foreground font-medium">Save</strong>{' '}
                    <code className="font-mono text-[10px]">Text</code> to{' '}
                    <code className="font-mono text-[10px]">Shortcuts</code> (path:{' '}
                    <code className="font-mono text-[10px]">opencalory-last-weight-id.txt</code>, with{' '}
                    <em>Overwrite If File Already Exists</em> turned on).
                  </li>
                </ul>
              </li>
              <li>
                <strong className="text-foreground font-medium">End If</strong>
              </li>
            </ul>
          </li>
          <li>
            <span className="text-foreground font-medium">Automate Daily Sync:</span>{' '}
            Open the <strong className="text-foreground font-medium">Automation</strong> tab in Shortcuts &rarr; tap{' '}
            <strong className="text-foreground font-medium">+</strong> &rarr;{' '}
            <strong className="text-foreground font-medium">Time of Day</strong> &rarr; set your preferred daily sync time (e.g.,{' '}
            <code className="font-mono text-[10px]">11:30 PM</code>), select{' '}
            <strong className="text-foreground font-medium">Daily</strong> and{' '}
            <strong className="text-foreground font-medium">Run Immediately</strong> &rarr; tap{' '}
            <strong className="text-foreground font-medium">Next</strong> and choose your shortcut (
            <code className="font-mono text-[10px]">Run Shortcut</code> &rarr; select the shortcut you built).
          </li>
        </ol>
      </div>
      </details>
    </section>
  );
}
