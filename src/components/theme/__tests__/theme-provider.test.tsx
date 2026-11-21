import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../theme-provider';
import { ThemeSwitcher } from '../theme-switcher';
import { BottomNav } from '@/components/shell/bottom-nav';
import { QuickActionDock } from '@/components/shell/quick-action-dock';

function ThemeConsumer() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolvedTheme">{resolvedTheme}</span>
      <button onClick={() => setTheme('light')}>Set Light</button>
      <button onClick={() => setTheme('dark')}>Set Dark</button>
      <button onClick={() => setTheme('system')}>Set System</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('defaults to dark theme and sets .dark on document.documentElement', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('allows changing theme to light and updates localStorage and document class', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Set Light'));
    });

    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('opencalory-theme')).toBe('light');
  });

  it('loads saved theme preference from localStorage', () => {
    localStorage.setItem('opencalory-theme', 'light');

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('verifies shell and theme components consume semantic tokens without hardcoded dark hexes and adapt across light/dark root toggles', () => {
    const { container } = render(
      <ThemeProvider>
        <ThemeSwitcher />
        <BottomNav onOpenQuickActions={() => {}} />
        <QuickActionDock onAction={() => {}} onClose={() => {}} />
      </ThemeProvider>
    );

    // 1. Verify ThemeSwitcher uses semantic tokens
    const switcher = screen.getByTestId('theme-switcher');
    expect(switcher.className).toContain('bg-surface-sub');
    expect(switcher.className).toContain('border-border');
    expect(switcher.className).not.toMatch(/#1[26B][0-9A-Fa-f]{4}/);

    // 2. Verify BottomNav uses semantic tokens
    const bottomNav = screen.getByTestId('bottom-nav');
    expect(bottomNav.className).toContain('bg-surface-card');
    expect(bottomNav.className).toContain('border-border');
    expect(bottomNav.className).not.toMatch(/#1[26B][0-9A-Fa-f]{4}/);

    // 3. Verify QuickActionDock uses semantic tokens
    const quickDock = screen.getByTestId('quick-action-dock');
    const dockSheet = quickDock.firstElementChild as HTMLElement;
    expect(dockSheet.className).toContain('bg-surface-elevated');
    expect(dockSheet.className).toContain('border-border');
    expect(dockSheet.className).not.toMatch(/#1[26B][0-9A-Fa-f]{4}/);

    // 4. Verify no child element in container has hardcoded dark hexes (#1B1D22, #16181D, #121316)
    const allHtml = container.innerHTML;
    expect(allHtml).not.toContain('1B1D22');
    expect(allHtml).not.toContain('16181D');
    expect(allHtml).not.toContain('121316');

    // 5. Toggle from dark to light using ThemeSwitcher button and verify root classes
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const lightBtn = screen.getByRole('button', { name: /light/i });
    act(() => {
      fireEvent.click(lightBtn);
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Toggle back to dark
    const darkBtn = screen.getByRole('button', { name: /dark/i });
    act(() => {
      fireEvent.click(darkBtn);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });
});
