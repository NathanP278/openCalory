'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { db } from '@/lib/db/opencalory-db';
import {
  EASE_EXPRESSIVE,
  SPRING_SHEET,
  isTestEnvironment,
  triggerHaptic,
} from '@/lib/motion';
import { useFocusTrap } from '@/hooks/use-focus-trap';

export interface DatePickerPopoverProps {
  activeDate: string;
  onSelectDate: (iso: string) => void;
  trigger: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function getTodayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseIsoMonth(iso: string): { year: number; month: number } {
  const parts = (iso || '').split('-').map(Number);
  if (parts.length === 3 && !parts.some(isNaN)) {
    return { year: parts[0], month: parts[1] - 1 };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

export function DatePickerPopover({
  activeDate,
  onSelectDate,
  trigger,
  align = 'left',
  className = '',
}: DatePickerPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [shiftX, setShiftX] = useState(0);
  const [viewMonth, setViewMonth] = useState<{ year: number; month: number }>(() =>
    parseIsoMonth(activeDate)
  );
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(popoverRef, isOpen);

  useLayoutEffect(() => {
    if (!isOpen || !popoverRef.current || typeof window === 'undefined') {
      setShiftX(0);
      return;
    }
    const rect = popoverRef.current.getBoundingClientRect();
    const margin = 16;
    let delta = 0;
    if (rect.right > window.innerWidth - margin) {
      delta = window.innerWidth - margin - rect.right;
    } else if (rect.left < margin) {
      delta = margin - rect.left;
    }
    setShiftX(Math.round(delta));
  }, [isOpen, align]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const daysInMonth = new Date(viewMonth.year, viewMonth.month + 1, 0).getDate();
  const leadingEmptyDays = new Date(viewMonth.year, viewMonth.month, 1).getDay();
  const monthPrefix = `${viewMonth.year}-${pad2(viewMonth.month + 1)}`;
  const monthStart = `${monthPrefix}-01`;
  const monthEnd = `${monthPrefix}-${pad2(daysInMonth)}`;

  const monthLogs = useLiveQuery(
    async () => {
      if (!isOpen) return [];
      return db.foodLogs.where('date').between(monthStart, monthEnd, true, true).toArray();
    },
    [isOpen, monthStart, monthEnd]
  );

  const loggedDates = useMemo(() => {
    const dates = new Set<string>();
    for (const entry of monthLogs ?? []) {
      if (entry?.date) {
        dates.add(entry.date);
      }
    }
    return dates;
  }, [monthLogs]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
      }
    };

    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isOpen]);

  const handleToggle = () => {
    triggerHaptic(6);
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        setViewMonth(parseIsoMonth(activeDate));
      }
      return next;
    });
  };

  const handlePrevMonth = () => {
    triggerHaptic(6);
    setViewMonth((prev) =>
      prev.month === 0
        ? { year: prev.year - 1, month: 11 }
        : { year: prev.year, month: prev.month - 1 }
    );
  };

  const handleNextMonth = () => {
    triggerHaptic(6);
    setViewMonth((prev) =>
      prev.month === 11
        ? { year: prev.year + 1, month: 0 }
        : { year: prev.year, month: prev.month + 1 }
    );
  };

  const handlePickDate = (iso: string) => {
    triggerHaptic(8);
    onSelectDate(iso);
    setIsOpen(false);
  };

  const todayIso = getTodayIsoDate();
  const handleJumpToday = () => {
    handlePickDate(todayIso);
  };

  const monthHeading = new Date(viewMonth.year, viewMonth.month, 1).toLocaleDateString(
    'en-US',
    { month: 'long', year: 'numeric' }
  );

  const isTriggerButton = React.isValidElement(trigger) && trigger.type === 'button';
  const renderedTrigger = isTriggerButton
    ? React.cloneElement(
        trigger as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>,
        {
          onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
            const origOnClick = (
              trigger.props as React.ButtonHTMLAttributes<HTMLButtonElement>
            )?.onClick;
            origOnClick?.(e);
            handleToggle();
          },
          'aria-expanded': isOpen,
          'aria-haspopup': 'dialog',
        }
      )
    : (
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          className="inline-flex items-center"
        >
          {trigger}
        </button>
      );

  const alignClasses =
    align === 'right'
      ? 'sm:right-0'
      : align === 'center'
        ? 'sm:left-1/2 sm:-translate-x-1/2'
        : 'sm:left-0';

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex min-w-0 ${className}`}
      onTouchStart={(e) => {
        if (isOpen) e.stopPropagation();
      }}
      onTouchEnd={(e) => {
        if (isOpen) e.stopPropagation();
      }}
    >
      {renderedTrigger}

      <AnimatePresence>
      {isOpen && (
        <React.Fragment key="date-picker-dialog">
          <motion.div
            data-testid="date-picker-backdrop"
            aria-hidden="true"
            initial={isTestEnvironment() ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={isTestEnvironment() ? undefined : { opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_EXPRESSIVE }}
            onClick={() => setIsOpen(false)}
            className="fixed inset-0 z-40 bg-black/45 sm:bg-transparent"
          />

          <motion.div
            ref={popoverRef}
            role="dialog"
            aria-modal="true"
            aria-label="Choose date"
            data-testid="date-picker-popover"
            initial={isTestEnvironment() ? false : { opacity: 0, y: -12, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={isTestEnvironment() ? undefined : { opacity: 0, y: -8, scale: 0.95 }}
            transition={SPRING_SHEET}
            onClick={(e) => e.stopPropagation()}
            style={shiftX !== 0 ? { marginLeft: `${shiftX}px` } : undefined}
            className={`fixed inset-x-4 top-[max(4.5rem,env(safe-area-inset-top))] sm:inset-x-auto sm:absolute sm:top-full sm:mt-2 ${alignClasses} z-50 w-auto sm:w-80`}
          >
            <div className="surface-elevated-sheet rounded-2xl p-3.5 sm:p-4">
            {/* Month Navigation Header */}
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-border/60">
              <button
                type="button"
                onClick={handlePrevMonth}
                aria-label="Previous month"
                className="touch-target tactile-press w-8 h-8 rounded-full flex items-center justify-center bg-surface-sub hover:bg-card text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>

              <span className="text-xs font-bold tracking-tight text-foreground tabular-nums">
                {monthHeading}
              </span>

              <button
                type="button"
                onClick={handleNextMonth}
                aria-label="Next month"
                className="touch-target tactile-press w-8 h-8 rounded-full flex items-center justify-center bg-surface-sub hover:bg-card text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {/* Weekday Labels */}
            <div
              aria-hidden="true"
              className="grid grid-cols-7 gap-1 pt-2.5 pb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {WEEKDAY_LABELS.map((day) => (
                <div key={day}>{day}</div>
              ))}
            </div>

            {/* Day Grid */}
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: leadingEmptyDays }).map((_, idx) => (
                <div key={`empty-${idx}`} aria-hidden="true" />
              ))}

              {Array.from({ length: daysInMonth }, (_, idx) => {
                const day = idx + 1;
                const iso = `${monthPrefix}-${pad2(day)}`;
                const isSelected = iso === activeDate;
                const isToday = iso === todayIso;
                const hasLogs = loggedDates.has(iso);
                const fullDate = new Date(viewMonth.year, viewMonth.month, day).toLocaleDateString(
                  'en-US',
                  {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  }
                );

                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => handlePickDate(iso)}
                    aria-current={isSelected ? 'date' : undefined}
                    aria-label={`${iso} (${fullDate})${hasLogs ? ', has logged entries' : ''}`}
                    className={`tactile-press min-h-[38px] rounded-xl flex flex-col items-center justify-center py-1 text-xs tabular-nums transition-colors ${
                      isSelected
                        ? 'bg-foreground text-background font-bold shadow-xs'
                        : isToday
                          ? 'bg-surface-sub ring-1 ring-[var(--macro-calories)]/60 text-foreground font-semibold hover:bg-card'
                          : 'text-foreground/90 hover:bg-surface-sub font-medium'
                    }`}
                  >
                    <span className="leading-none">{day}</span>
                    <span className="h-1.5 flex items-center justify-center mt-1">
                      {hasLogs && (
                        <span
                          data-testid={`calendar-dot-${iso}`}
                          aria-hidden="true"
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: 'var(--macro-calories)' }}
                        />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Footer Today Jump & Legend */}
            <div className="flex items-center justify-between gap-2 pt-3 mt-2.5 border-t border-border/60">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  aria-hidden="true"
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: 'var(--macro-calories)' }}
                />
                <span>Logged day</span>
              </span>

              <button
                type="button"
                onClick={handleJumpToday}
                className="tactile-press inline-flex items-center gap-1 px-3 py-1 rounded-full bg-surface-sub hover:bg-foreground hover:text-background text-[11px] font-semibold text-foreground transition-colors"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                <span>Today</span>
              </button>
            </div>
            </div>
          </motion.div>
        </React.Fragment>
      )}
      </AnimatePresence>
    </div>
  );
}
