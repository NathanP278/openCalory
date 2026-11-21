import 'fake-indexeddb/auto';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { parseOffProduct, searchOffFoods } from '../off-adapter';
import { lookupBarcodeWaterfall, useBarcodeLookup, type BarcodeLookupResult } from '@/hooks/use-barcode-lookup';
import { GET as offRouteHandler } from '@/app/api/off/[barcode]/route';
import { GET as offSearchRouteHandler } from '@/app/api/off/search/route';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db/opencalory-db';

describe('Open Food Facts Adapter & Barcode Waterfall', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseOffProduct', () => {
    test('returns null on OFF status === 0 even when HTTP 200', () => {
      expect(parseOffProduct('999999', { status: 0, status_verbose: 'product not found' })).toBeNull();
    });

    test('returns null on invalid payloads or missing product object', () => {
      expect(parseOffProduct('999999', null)).toBeNull();
      expect(parseOffProduct('999999', {})).toBeNull();
      expect(parseOffProduct('999999', { status: 1 })).toBeNull();
    });

    test('uses energy-kcal_100g and ignores kJ energy field; falls back to perServing', () => {
      const item = parseOffProduct('0111', {
        status: 1,
        product: {
          product_name: 'Oat Milk',
          nutriments: {
            energy: 192,
            'energy-kcal_100g': 46,
            proteins_100g: 1,
            carbohydrates_100g: 6.5,
            fat_100g: 1.5,
          },
        },
      });
      expect(item).not.toBeNull();
      expect(item?.basis).toBe('per100g');
      expect(item?.nutrientsPerBasis.calories).toBe(46);
      expect(item?.nutrientsPerBasis.protein).toBe(1);
      expect(item?.nutrientsPerBasis.carbs).toBe(6.5);
      expect(item?.nutrientsPerBasis.fat).toBe(1.5);
      expect(item?.id).toBe('off:0111');
      expect(item?.barcode).toBe('0111');
      expect(item?.source).toBe('off');

      const servingOnly = parseOffProduct('0222', {
        status: 1,
        product: {
          product_name: 'Electrolyte Tab',
          serving_quantity: 1,
          nutriments: {
            energy: 420,
            'energy-kcal_serving': 15,
            carbohydrates_serving: 3,
          },
        },
      });
      expect(servingOnly).not.toBeNull();
      expect(servingOnly?.basis).toBe('perServing');
      expect(servingOnly?.nutrientsPerBasis.calories).toBe(15);
      expect(servingOnly?.nutrientsPerBasis.carbs).toBe(3);
    });

    test('determines per100ml basis when liquid units or 100ml fields are present', () => {
      const liquid1 = parseOffProduct('0333', {
        status: 1,
        product: {
          product_name: 'Cold Brew Coffee',
          product_quantity_unit: 'ml',
          nutriments: {
            'energy-kcal_100ml': 3,
            proteins_100ml: 0.3,
            carbohydrates_100ml: 0.5,
            fat_100ml: 0,
          },
        },
      });
      expect(liquid1?.basis).toBe('per100ml');
      expect(liquid1?.servingUnit).toBe('ml');
      expect(liquid1?.nutrientsPerBasis.calories).toBe(3);

      const liquid2 = parseOffProduct('0444', {
        status: 1,
        product: {
          product_name: 'Orange Juice',
          serving_quantity_unit: 'ml',
          nutriments: {
            'energy-kcal_100g': 45,
            carbohydrates_100g: 10,
          },
        },
      });
      expect(liquid2?.basis).toBe('per100ml');
      expect(liquid2?.nutrientsPerBasis.calories).toBe(45);
    });

    test('converts sodium from grams to sodiumMg (* 1000) and falls back to salt * 400', () => {
      const withSodium = parseOffProduct('0555', {
        status: 1,
        product: {
          product_name: 'Salted Crackers',
          nutriments: {
            'energy-kcal_100g': 420,
            sodium_100g: 0.65, // 0.65g -> 650mg
          },
        },
      });
      expect(withSodium?.micronutrientsPerBasis.sodiumMg).toBe(650);

      const withSalt = parseOffProduct('0666', {
        status: 1,
        product: {
          product_name: 'Pretzels',
          nutriments: {
            'energy-kcal_100g': 380,
            salt_100g: 2.5, // 2.5g salt -> 1000mg sodium
          },
        },
      });
      expect(withSalt?.micronutrientsPerBasis.sodiumMg).toBe(1000);

      const withServingSodium = parseOffProduct('0777', {
        status: 1,
        product: {
          product_name: 'Single Snack Pack',
          serving_quantity: 1,
          nutriments: {
            'energy-kcal_serving': 110,
            sodium_serving: 0.15, // 0.15g -> 150mg
          },
        },
      });
      expect(withServingSodium?.basis).toBe('perServing');
      expect(withServingSodium?.micronutrientsPerBasis.sodiumMg).toBe(150);
    });

    test('parses OFF extended nutrients across 100g and serving bases with g->mg conversion for cholesterol and caffeine', () => {
      const per100gItem = parseOffProduct('0888', {
        status: 1,
        product: {
          product_name: 'Dark Chocolate Espresso Bar',
          nutriments: {
            'energy-kcal_100g': 540,
            sugars_100g: 32.5,
            'added-sugars_100g': 28,
            'saturated-fat_100g': 22.4,
            cholesterol_100g: 0.015, // 15mg
            caffeine_100g: 0.085, // 85mg
            alcohol_100g: 1.2,
          },
        },
      });
      expect(per100gItem?.micronutrientsPerBasis).toMatchObject({
        sugarG: 32.5,
        addedSugarG: 28,
        saturatedFatG: 22.4,
        cholesterolMg: 15,
        caffeineMg: 85,
        alcoholG: 1.2,
      });

      const perServingItem = parseOffProduct('0889', {
        status: 1,
        product: {
          product_name: 'Canned Iced Latte',
          serving_quantity: 250,
          serving_quantity_unit: 'ml',
          nutriments: {
            'energy-kcal_serving': 140,
            sugars_serving: 18,
            'added-sugars_serving': 12,
            'saturated-fat_serving': 2.5,
            cholesterol_serving: 0.01, // 10mg
            caffeine_serving: 0.12, // 120mg
            alcohol_serving: 0,
          },
        },
      });
      expect(perServingItem?.basis).toBe('perServing');
      expect(perServingItem?.micronutrientsPerBasis).toMatchObject({
        sugarG: 18,
        addedSugarG: 12,
        saturatedFatG: 2.5,
        cholesterolMg: 10,
        caffeineMg: 120,
        alcoholG: 0,
      });
    });
  });

  describe('lookupBarcodeWaterfall', () => {
    test('checks openCaloryDB.foodsCache before calling /api/off', async () => {
      await db.foodsCache.put({
        id: 'custom:1',
        barcode: '888',
        source: 'custom_barcode',
        name: 'Local Bar',
        basis: 'perServing',
        servingSize: 1,
        servingUnit: 'serving',
        nutrientsPerBasis: { calories: 210, protein: 20, carbs: 18, fat: 7, fiber: 3 },
        micronutrientsPerBasis: {},
        updatedAt: 1,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const res = await lookupBarcodeWaterfall('888');

      expect(res.status).toBe('hit');
      if (res.status === 'hit') {
        expect(res.item.name).toBe('Local Bar');
      }
      expect(fetchSpy).not.toHaveBeenCalled();

      // Also hits when scanned as 12-digit UPC-A vs 13-digit EAN-13 leading-zero alias
      await db.foodsCache.put({
        id: 'off:0049000042566',
        barcode: '0049000042566',
        source: 'off',
        name: 'Coca-Cola Zero Sugar',
        basis: 'per100ml',
        servingSize: 100,
        servingUnit: 'ml',
        nutrientsPerBasis: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
        micronutrientsPerBasis: {},
        updatedAt: 1,
      });
      const aliasRes = await lookupBarcodeWaterfall('049000042566');
      expect(aliasRes.status).toBe('hit');
      if (aliasRes.status === 'hit') {
        expect(aliasRes.item.name).toBe('Coca-Cola Zero Sugar');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('fetches /api/off on cache miss, caches item, and returns hit', async () => {
      const mockOffData = {
        status: 1,
        product: {
          product_name: 'Greek Yogurt',
          brands: 'Chobani',
          nutriments: {
            'energy-kcal_100g': 97,
            proteins_100g: 10,
            carbohydrates_100g: 4,
            fat_100g: 5,
            fiber_100g: 0,
          },
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(mockOffData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await lookupBarcodeWaterfall('001234567890');
      expect(res.status).toBe('hit');
      if (res.status === 'hit') {
        expect(res.item.name).toBe('Greek Yogurt');
        expect(res.item.brand).toBe('Chobani');
        expect(res.item.nutrientsPerBasis.calories).toBe(97);
      }
      expect(fetchSpy).toHaveBeenCalledWith('/api/off/001234567890');

      // Verify it was cached in Dexie
      const cached = await db.foodsCache.where('barcode').equals('001234567890').first();
      expect(cached).toBeDefined();
      expect(cached?.name).toBe('Greek Yogurt');
    });

    test('returns missing when OFF product is not found (status 0)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 0, status_verbose: 'product not found' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await lookupBarcodeWaterfall('99999999');
      expect(res.status).toBe('missing');
      if (res.status === 'missing') {
        expect(res.barcode).toBe('99999999');
      }
    });

    test('returns missing when /api/off returns 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: 'Product not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await lookupBarcodeWaterfall('40404040');
      expect(res.status).toBe('missing');
    });

    test('returns offline-miss when network fetch fails / rejects', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch (offline)'));

      const res = await lookupBarcodeWaterfall('12345678');
      expect(res.status).toBe('offline-miss');
      if (res.status === 'offline-miss') {
        expect(res.barcode).toBe('12345678');
      }
    });

    test('returns offline-miss when /api/off returns 502 / 5xx', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: 'Bad Gateway' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await lookupBarcodeWaterfall('502502502');
      expect(res.status).toBe('offline-miss');
    });

    test('returns offline-miss when /api/off returns 429 rate-limited', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await lookupBarcodeWaterfall('429429429');
      expect(res.status).toBe('offline-miss');
      if (res.status === 'offline-miss') {
        expect(res.barcode).toBe('429429429');
      }
    });
  });

  describe('/api/off/[barcode] route handler', () => {
    test('validates barcode matches 4-18 digits and rejects non-numeric or short barcodes with 400', async () => {
      const shortReq = new NextRequest('http://localhost:3000/api/off/123');
      const shortRes = await offRouteHandler(shortReq, { params: Promise.resolve({ barcode: '123' }) });
      expect(shortRes.status).toBe(400);

      const alphaReq = new NextRequest('http://localhost:3000/api/off/abc12345');
      const alphaRes = await offRouteHandler(alphaReq, { params: Promise.resolve({ barcode: 'abc12345' }) });
      expect(alphaRes.status).toBe(400);

      const tooLongReq = new NextRequest('http://localhost:3000/api/off/1234567890123456789');
      const tooLongRes = await offRouteHandler(tooLongReq, { params: Promise.resolve({ barcode: '1234567890123456789' }) });
      expect(tooLongRes.status).toBe(400);
    });

    test('forwards request to Open Food Facts with User-Agent header and returns Cache-Control on status 1', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        expect(urlStr).toMatch(
          /^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/737628064502\.json\?fields=/
        );
        expect(new Headers(init?.headers).get('User-Agent')).toBe('openCalory/1.0');

        return new Response(
          JSON.stringify({
            status: 1,
            product: { product_name: 'Peanut Butter' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const req = new NextRequest('http://localhost:3000/api/off/737628064502');
      const res = await offRouteHandler(req, { params: Promise.resolve({ barcode: '737628064502' }) });
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
      expect(fetchSpy).toHaveBeenCalled();
    });

    test('sets Cache-Control: no-store when product not found (status 0)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ status: 0, status_verbose: 'product not found' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const req = new NextRequest('http://localhost:3000/api/off/99999999');
      const res = await offRouteHandler(req, { params: Promise.resolve({ barcode: '99999999' }) });
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    test('returns 502 cleanly on upstream timeout or network failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Gateway timeout'));

      const req = new NextRequest('http://localhost:3000/api/off/12345678');
      const res = await offRouteHandler(req, { params: Promise.resolve({ barcode: '12345678' }) });
      expect(res.status).toBe(502);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const body = await res.json();
      expect(body.error).toBe('Failed to communicate with Open Food Facts API');
    });
  });

  describe('useBarcodeLookup React hook', () => {
    test('manages loading state and returns lookup result', async () => {
      await db.foodsCache.put({
        id: 'off:55555',
        barcode: '55555',
        source: 'off',
        name: 'Hook Almond Milk',
        basis: 'per100ml',
        servingSize: 100,
        servingUnit: 'ml',
        nutrientsPerBasis: { calories: 30, protein: 1, carbs: 1, fat: 2.5, fiber: 0 },
        micronutrientsPerBasis: {},
        updatedAt: 10,
      });

      const { result } = renderHook(() => useBarcodeLookup());

      expect(result.current.isLoading).toBe(false);
      expect(result.current.result).toBeNull();

      let lookupRes: BarcodeLookupResult | undefined;
      await act(async () => {
        lookupRes = await result.current.lookup('55555');
      });

      expect(result.current.isLoading).toBe(false);
      expect(lookupRes?.status).toBe('hit');
      if (lookupRes?.status === 'hit') {
        expect(lookupRes.item.name).toBe('Hook Almond Milk');
      }
      expect(result.current.result?.status).toBe('hit');

      act(() => {
        result.current.reset();
      });
      expect(result.current.result).toBeNull();
    });
  });

  describe('OFF search route & serving options extraction', () => {
    test('parseOffProduct extracts countable servingOptions and PH region when metadata exists', () => {
      const item = parseOffProduct('4800016644801', {
        status: 1,
        product: {
          product_name: 'Pancit Canton Original',
          brands: 'Lucky Me!',
          countries_tags: ['en:philippines'],
          serving_size: '1 pack (80 g)',
          serving_quantity: 80,
          serving_quantity_unit: 'g',
          nutriments: {
            'energy-kcal_100g': 462.5,
            proteins_100g: 10,
            carbohydrates_100g: 62.5,
            fat_100g: 18.75,
          },
        },
      });

      expect(item).not.toBeNull();
      expect(item?.region).toBe('PH');
      expect(item?.servingWeightGrams).toBe(80);
      expect(item?.servingOptions?.map((o) => o.unit)).toEqual(['pack', 'g']);
      expect(item?.servingOptions?.[0].grams).toBe(80);

      const plain = parseOffProduct('111222', {
        status: 1,
        product: {
          product_name: 'Plain Oats',
          nutriments: {
            'energy-kcal_100g': 380,
            proteins_100g: 13,
            carbohydrates_100g: 66,
            fat_100g: 7,
          },
        },
      });
      expect(plain?.servingOptions).toBeUndefined();
    });

    test('GET /api/off/search validates query and routes ph vs world hosts', async () => {
      const badReq = new NextRequest('http://localhost:3000/api/off/search');
      const badRes = await offSearchRouteHandler(badReq);
      expect(badRes.status).toBe(400);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
        const parsed = new URL(String(url));
        expect(parsed.searchParams.get('search_terms')).toBe('lucky me');
        return new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const phReq = new NextRequest('http://localhost:3000/api/off/search?query=lucky%20me&country=ph');
      const phRes = await offSearchRouteHandler(phReq);
      expect(phRes.status).toBe(200);
      expect(String(fetchSpy.mock.calls[0][0])).toContain('https://ph.openfoodfacts.org/cgi/search.pl');

      const worldReq = new NextRequest('http://localhost:3000/api/off/search?query=lucky%20me&country=world');
      const worldRes = await offSearchRouteHandler(worldReq);
      expect(worldRes.status).toBe(200);
      expect(String(fetchSpy.mock.calls[1][0])).toContain('https://world.openfoodfacts.org/cgi/search.pl');
    });

    test('searchOffFoods filters stubs and tags PH catalog products', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            products: [
              { code: '000001', product_name: '', nutriments: {} },
              {
                code: '4800016644801',
                product_name: 'Pancit Canton Original',
                brands: 'Lucky Me!',
                serving_size: '1 pack (80 g)',
                nutriments: { 'energy-kcal_100g': 462.5, proteins_100g: 10 },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const hits = await searchOffFoods('pancit', { country: 'ph' });
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe('off:4800016644801');
      expect(hits[0].region).toBe('PH');
      expect(hits[0].servingOptions?.[0].unit).toBe('pack');
    });
  });
});
