import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import manifest from '../manifest';
import { PwaRegister } from '@/components/shell/pwa-register';

describe('Task 13: Manifest, Service Worker & PwaRegister', () => {
  describe('manifest.ts', () => {
    it('returns standalone PWA manifest for openCalory', () => {
      const m = manifest();
      expect(m.name).toBe('openCalory');
      expect(m.short_name).toBe('openCalory');
      expect(m.description).toBe('Offline-first, adherence-neutral calorie & macro tracking PWA');
      expect(m.start_url).toBe('/');
      expect(m.display).toBe('standalone');
      expect(m.background_color).toBe('#121316');
      expect(m.theme_color).toBe('#121316');
      expect(m.icons?.length).toBeGreaterThanOrEqual(2);

      const icon192 = m.icons?.find((i) => i.sizes === '192x192');
      const icon512 = m.icons?.find((i) => i.sizes === '512x512');
      expect(icon192).toBeDefined();
      expect(icon192?.src).toBe('/icons/icon-192.png');
      expect(icon192?.type).toBe('image/png');

      expect(icon512).toBeDefined();
      expect(icon512?.src).toBe('/icons/icon-512.png');
      expect(icon512?.type).toBe('image/png');
    });
  });

  describe('PWA Icons on disk', () => {
    function readPngHeader(relPath: string) {
      const fullPath = path.resolve(process.cwd(), relPath);
      expect(fs.existsSync(fullPath)).toBe(true);
      const buf = fs.readFileSync(fullPath);
      // PNG Signature: 89 50 4E 47 0D 0A 1A 0A
      const expectedSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(buf.subarray(0, 8).equals(expectedSig)).toBe(true);

      const ihdrChunkType = buf.subarray(12, 16).toString('ascii');
      expect(ihdrChunkType).toBe('IHDR');

      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height };
    }

    it('has valid 192x192 PNG icon', () => {
      const { width, height } = readPngHeader('public/icons/icon-192.png');
      expect(width).toBe(192);
      expect(height).toBe(192);
    });

    it('has valid 512x512 PNG icon', () => {
      const { width, height } = readPngHeader('public/icons/icon-512.png');
      expect(width).toBe(512);
      expect(height).toBe(512);
    });
  });

  describe('public/sw.js Service Worker file', () => {
    it('implements required offline caching strategies and precache list (v3 with /trends & food-catalog.db.gz)', () => {
      const swPath = path.resolve(process.cwd(), 'public/sw.js');
      expect(fs.existsSync(swPath)).toBe(true);
      const sw = fs.readFileSync(swPath, 'utf-8');

      // Version bump
      expect(sw).toContain("CACHE_NAME = 'opencalory-v3'");

      // Precache assets
      const precacheMatch = sw.match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\]/);
      expect(precacheMatch).not.toBeNull();
      const precacheBlock = precacheMatch![1];
      expect(precacheBlock).toContain("'/trends'");
      expect(precacheBlock).toContain("'/data/catalog-manifest.json'");
      expect(precacheBlock).toContain("'/data/food-catalog.db.gz'");
      expect(precacheBlock).toContain("'/icons/icon-192.png'");
      expect(precacheBlock).toContain("'/icons/icon-512.png'");
      expect(precacheBlock).toContain("'/manifest.webmanifest'");

      // Lifecycle hooks
      expect(sw).toMatch(/skipWaiting/);
      expect(sw).toMatch(/clients\.claim/);

      // Routing strategies: verify cache-first branch covers catalog-manifest.json and food-catalog.db.gz
      const fetchBlock = sw.slice(sw.indexOf("addEventListener('fetch'"));
      expect(fetchBlock).toMatch(/\/api\//); // network-only for api
      expect(sw).toContain('/data/catalog-manifest.json');
      expect(sw).toContain('/data/food-catalog.db.gz');

      // Execute SW fetch handler in isolation to prove cache-first serves /data/food-catalog.db.gz
      const listeners: Record<string, (event: unknown) => void> = {};
      const cachedCatalogResponse = { ok: true, status: 200, id: 'cached-catalog' };
      const cachesMatchMock = vi.fn().mockResolvedValue(cachedCatalogResponse);
      const fetchMock = vi.fn();

      const swRunner = new Function(
        'self',
        'caches',
        'fetch',
        'URL',
        sw
      );
      const fakeSelf = {
        location: { origin: 'https://opencalory.test' },
        addEventListener: (type: string, cb: (event: unknown) => void) => {
          listeners[type] = cb;
        },
        skipWaiting: vi.fn(),
        clients: { claim: vi.fn() },
      };
      swRunner(
        fakeSelf,
        { match: cachesMatchMock, open: vi.fn(), keys: vi.fn().mockResolvedValue([]) },
        fetchMock,
        URL
      );

      let respondedPromise: Promise<unknown> | undefined;
      listeners.fetch({
        request: { method: 'GET', url: 'https://opencalory.test/data/food-catalog.db.gz' },
        respondWith: (p: Promise<unknown>) => {
          respondedPromise = p;
        },
      });
      expect(respondedPromise).toBeDefined();
      return expect(respondedPromise).resolves.toBe(cachedCatalogResponse).then(() => {
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('PwaRegister component', () => {
    const originalNavigator = window.navigator;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      Object.defineProperty(window, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    });

    it('registers service worker when navigator.serviceWorker is supported', () => {
      const registerMock = vi.fn().mockResolvedValue({});
      Object.defineProperty(window, 'navigator', {
        value: {
          ...originalNavigator,
          serviceWorker: { register: registerMock },
          onLine: true,
        },
        configurable: true,
        writable: true,
      });

      render(React.createElement(PwaRegister));
      expect(registerMock).toHaveBeenCalledWith('/sw.js');
    });

    it('does not display offline banner when online', () => {
      Object.defineProperty(window, 'navigator', {
        value: {
          ...originalNavigator,
          serviceWorker: { register: vi.fn().mockResolvedValue({}) },
          onLine: true,
        },
        configurable: true,
        writable: true,
      });

      render(React.createElement(PwaRegister));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('displays adherence-neutral offline banner when offline', () => {
      Object.defineProperty(window, 'navigator', {
        value: {
          ...originalNavigator,
          serviceWorker: { register: vi.fn().mockResolvedValue({}) },
          onLine: false,
        },
        configurable: true,
        writable: true,
      });

      render(React.createElement(PwaRegister));
      const banner = screen.getByRole('status');
      expect(banner).toBeInTheDocument();
      expect(banner.textContent?.toLowerCase()).toMatch(/offline/i);
      expect(banner.textContent?.toLowerCase()).toMatch(/staples/i);
    });

    it('updates status when online and offline window events fire', () => {
      let isOnline = true;
      Object.defineProperty(window, 'navigator', {
        get: () => ({
          ...originalNavigator,
          serviceWorker: { register: vi.fn().mockResolvedValue({}) },
          onLine: isOnline,
        }),
        configurable: true,
      });

      render(React.createElement(PwaRegister));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      act(() => {
        isOnline = false;
        window.dispatchEvent(new Event('offline'));
      });
      expect(screen.getByRole('status')).toBeInTheDocument();

      act(() => {
        isOnline = true;
        window.dispatchEvent(new Event('online'));
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });
});
