import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const GLOBALS_CSS_PATH = path.join(ROOT, 'src', 'app', 'globals.css');

const MODAL_OVERLAY_FILES = [
  'src/components/log/copy-from-date-drawer.tsx',
  'src/components/logging/edit-log-entry-drawer.tsx',
  'src/components/logging/food-search-drawer.tsx',
  'src/components/logging/quick-add-drawer.tsx',
  'src/components/motion/motion-primitives.tsx',
  'src/components/recipes/custom-food-modal.tsx',
  'src/components/recipes/recipe-builder-modal.tsx',
  'src/components/recipes/recipe-portion-picker-modal.tsx',
  'src/components/scanner/add-barcode-product-modal.tsx',
  'src/components/scanner/ai-meal-ideas-drawer.tsx',
  'src/components/scanner/ai-meal-scanner-sheet.tsx',
  'src/components/scanner/barcode-scanner-drawer.tsx',
  'src/components/scanner/hitl-verification-swap-modal.tsx',
  'src/components/settings/backup-panel.tsx',
  'src/components/shell/command-palette.tsx',
  'src/components/weight/weigh-in-drawer.tsx',
];

function extractRuleBlock(css: string, selectorStart: string): string {
  const idx = css.indexOf(selectorStart);
  if (idx === -1) return '';
  const openBrace = css.indexOf('{', idx);
  if (openBrace === -1) return '';
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(openBrace, i + 1);
    }
  }
  return '';
}

describe('Tiered Liquid Glass & GPU compositing hygiene', () => {
  const globalsCss = fs.readFileSync(GLOBALS_CSS_PATH, 'utf8');

  it('removes full-viewport live blur from body::after', () => {
    const blocks: string[] = [];
    let pos = 0;
    while (true) {
      const idx = globalsCss.indexOf('body::after', pos);
      if (idx === -1) break;
      const block = extractRuleBlock(globalsCss, globalsCss.slice(idx, idx + 20));
      if (block) blocks.push(block);
      pos = idx + 'body::after'.length;
    }
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/filter\s*:\s*blur\(/i);
    }
  });

  it('keeps Tier 2 surfaces free of nested backdrop-filter blur', () => {
    const tier2Selectors = [
      '.bg-card,',
      '.bg-surface-sub {',
      '.bg-surface-elevated {',
      '.surface-glass-card {',
      '.surface-glass-pill {',
      '.liquid-pill-glass {',
      '.liquid-input-well {',
    ];

    for (const selector of tier2Selectors) {
      const block = extractRuleBlock(globalsCss, selector);
      expect(block, `expected block for ${selector}`).not.toBe('');
      expect(block, `${selector} must not apply backdrop-filter`).not.toMatch(
        /backdrop-filter\s*:/i
      );
    }
  });

  it('never animates backdrop-filter in CSS transition lists', () => {
    const transitionMatches = globalsCss.match(/transition\s*:[^;]+;/gi) ?? [];
    for (const decl of transitionMatches) {
      expect(decl).not.toMatch(/backdrop-filter/i);
    }
  });

  it('disables live sheet backdrop-filter when mobile keyboard is open', () => {
    const kbSheetBlock = extractRuleBlock(
      globalsCss,
      'html.keyboard-open .surface-elevated-sheet'
    );
    expect(kbSheetBlock).not.toBe('');
    expect(kbSheetBlock).toMatch(/backdrop-filter\s*:\s*none/i);
  });

  it('defines .food-search-row with CSS content-visibility containment', () => {
    const rowBlock = extractRuleBlock(globalsCss, '.food-search-row');
    expect(rowBlock).not.toBe('');
    expect(rowBlock).toMatch(/content-visibility\s*:\s*auto/i);
    expect(rowBlock).toMatch(/contain\s*:/i);
  });

  it('removes redundant backdrop-blur from full-screen modal backdrop scrims', () => {
    for (const relPath of MODAL_OVERLAY_FILES) {
      const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      const lines = content.split(/\r?\n/);
      const offending = lines.filter(
        (line) =>
          (line.includes('modal-viewport-overlay') || line.includes('fixed inset-0 z-50')) &&
          /backdrop-blur-/.test(line)
      );
      expect(offending, `${relPath} should not use backdrop-blur on modal scrim`).toEqual([]);
    }
  });
});
