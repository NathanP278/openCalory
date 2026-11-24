import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  NATIONAL_TABLE_SOURCES,
  nationalTablesAdapter,
  parseCiqualCsvText,
  parseCnfCsvDir,
  parseNationalTableRows,
} from '../../../../scripts/catalog-adapters/national-tables';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('National tables adapter: CNF & Ciqual parsers and auto-downloaders', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parseCnfCsvDir joins synthetic Health Canada CNF CSVs (including 1 subdirectory deep) into rows accepted by parseNationalTableRows', () => {
    const dir = makeTempDir('cnf-test-');
    tempDirs.push(dir);
    const subDir = path.join(dir, 'cnf-fcen-csv');
    fs.mkdirSync(subDir, { recursive: true });

    fs.writeFileSync(
      path.join(subDir, 'FOOD GROUP.csv'),
      ['FoodGroupID,FoodGroupCode,FoodGroupName', '1,1,Dairy and Egg Products'].join('\n'),
      'utf8'
    );

    fs.writeFileSync(
      path.join(subDir, 'FOOD NAME.csv'),
      [
        'FoodID,FoodCode,FoodGroupID,FoodDescription',
        '101,1001,1,"Cheese, cheddar"',
        '102,1002,1,"Yogurt, plain, 2% M.F."',
      ].join('\n'),
      'utf8'
    );

    fs.writeFileSync(
      path.join(subDir, 'NUTRIENT NAME.csv'),
      [
        'NutrientID,NutrientCode,NutrientSymbol,NutrientUnit,NutrientName',
        '1,208,KCAL,kCal,ENERGY (KILOCALORIES)',
        '2,203,PROT,g,PROTEIN',
        '3,205,CARB,g,CARBOHYDRATE',
        '4,204,FAT,g,FAT (TOTAL LIPIDS)',
        '5,291,TDF,g,FIBRE, TOTAL DIETARY',
        '6,307,NA,mg,SODIUM',
        '7,269,TSUG,g,SUGARS, TOTAL',
        '8,606,FASAT,g,FATTY ACIDS, SATURATED, TOTAL',
        '9,301,CA,mg,CALCIUM',
        '10,303,FE,mg,IRON',
        '11,306,K,mg,POTASSIUM',
      ].join('\n'),
      'utf8'
    );

    fs.writeFileSync(
      path.join(subDir, 'NUTRIENT AMOUNT.csv'),
      [
        'FoodID,NutrientID,NutrientValue',
        '101,1,403',
        '101,2,24.9',
        '101,3,1.28',
        '101,4,33.14',
        '101,5,0',
        '101,6,621',
        '101,7,0.52',
        '101,8,21.09',
        '101,9,721',
        '101,10,0.68',
        '101,11,98',
        '102,1,63',
        '102,2,5.25',
        '102,3,7.04',
        '102,4,1.55',
        '102,5,0',
      ].join('\n'),
      'utf8'
    );

    const rows = parseCnfCsvDir(dir);
    expect(rows).toHaveLength(2);

    const items = parseNationalTableRows('cnf', rows);
    expect(items).toHaveLength(2);

    const cheddar = items.find((item) => item.id === 'cnf:101');
    expect(cheddar).toBeDefined();
    expect(cheddar!.sourceProvider).toBe('cnf');
    expect(cheddar!.region).toBe('CA');
    expect(cheddar!.accuracyTier).toBe(1);
    expect(cheddar!.category).toBe('Dairy and Egg Products');
    expect(cheddar!.nutrientsPerBasis).toEqual({
      calories: 403,
      protein: 24.9,
      carbs: 1.28,
      fat: 33.14,
      fiber: 0,
    });
    expect(cheddar!.micronutrientsPerBasis).toEqual({
      sodiumMg: 621,
      sugarG: 0.52,
      saturatedFatG: 21.09,
      calciumMg: 721,
      ironMg: 0.68,
      potassiumMg: 98,
    });
  });

  test('parseCnfCsvDir returns [] when required CNF files are missing', () => {
    const dir = makeTempDir('cnf-empty-');
    tempDirs.push(dir);
    expect(parseCnfCsvDir(dir)).toEqual([]);
  });

  test('parseCiqualCsvText parses semicolon-delimited French/English Ciqual rows with decimal commas, "< 0,5", "-", and "traces"', () => {
    const frenchCsv = [
      'alim_code;alim_nom_fr;alim_grp_nom_fr;Energie, Règlement UE N° 1169/2011 (kJ/100 g);Energie, Règlement UE N° 1169/2011 (kcal/100 g);Protéines, N x facteur de Jones (g/100 g);Glucides (g/100 g);Lipides (g/100 g);Fibres alimentaires (g/100 g);Sodium (mg/100 g);Sucres (g/100 g);AG saturés (g/100 g)',
      '12001;Camembert au lait cru;produits laitiers;1150;276;20,5;< 0,5;21,4;-;650;traces;14,2',
      '20001;Baguette de tradition;produits céréaliers;1180;279;8,7;56,3;1,2;3,1;620;2,4;0,3',
    ].join('\n');

    const rows = parseCiqualCsvText(frenchCsv);
    expect(rows).toHaveLength(2);

    const items = parseNationalTableRows('ciqual', rows);
    expect(items).toHaveLength(2);

    const camembert = items.find((i) => i.id === 'ciqual:12001');
    expect(camembert).toBeDefined();
    expect(camembert!.sourceProvider).toBe('ciqual');
    expect(camembert!.region).toBe('FR');
    expect(camembert!.accuracyTier).toBe(1);
    expect(camembert!.nutrientsPerBasis).toEqual({
      calories: 276,
      protein: 20.5,
      carbs: 0,
      fat: 21.4,
      fiber: 0,
    });
    expect(camembert!.micronutrientsPerBasis).toEqual({
      sodiumMg: 650,
      saturatedFatG: 14.2,
    });

    const englishCsv = [
      'alim_code;alim_nom_eng;alim_grp_nom_eng;Energy, Regulation EU No 1169/2011 (kcal/100g);Protein (g/100g);Carbohydrate (g/100g);Fat (g/100g);Fibres (g/100g);Sodium (mg/100g);Sugars (g/100g);Saturated fatty acids (g/100g)',
      '25001;Croissant, butter;cereal products;406,5;8,2;45,8;21,1;2,6;410;11,3;12,4',
    ].join('\n');

    const engRows = parseCiqualCsvText(englishCsv);
    const engItems = parseNationalTableRows('ciqual', engRows);
    expect(engItems).toHaveLength(1);
    expect(engItems[0].id).toBe('ciqual:25001');
    expect(engItems[0].category).toBe('cereal products');
    expect(engItems[0].nutrientsPerBasis).toEqual({
      calories: 406.5,
      protein: 8.2,
      carbs: 45.8,
      fat: 21.1,
      fiber: 2.6,
    });
    expect(engItems[0].micronutrientsPerBasis).toEqual({
      sodiumMg: 410,
      sugarG: 11.3,
      saturatedFatG: 12.4,
    });
  });

  test('parseCiqualCsvText returns [] for HTML error pages rather than garbage rows', () => {
    expect(parseCiqualCsvText('<!DOCTYPE html><html><body>503 Service Unavailable</body></html>')).toEqual([]);
    expect(parseCiqualCsvText('  \n  <html><head><title>Error</title></head><body>404</body></html>')).toEqual([]);
  });

  test('NATIONAL_TABLE_SOURCES defines downloadUrl for cnf and ciqual', () => {
    const cnf = NATIONAL_TABLE_SOURCES.find((s) => s.id === 'cnf');
    const ciqual = NATIONAL_TABLE_SOURCES.find((s) => s.id === 'ciqual');
    expect(cnf?.downloadUrl).toContain('cnf-fcen-csv.zip');
    expect(ciqual?.downloadUrl).toContain('data.gouv.fr');
  });

  test('nationalTablesAdapter.load returns [] cleanly in offlineOnly mode with empty cacheDir', async () => {
    const emptyTmpDir = makeTempDir('national-offline-');
    tempDirs.push(emptyTmpDir);

    const items = await nationalTablesAdapter.load({
      tier: 'core',
      cacheDir: emptyTmpDir,
      offlineOnly: true,
    });

    expect(items).toEqual([]);
  });

  test('nationalTablesAdapter.load handles HTML error responses gracefully without writing corrupted cache files', async () => {
    const tmpDir = makeTempDir('national-html-err-');
    tempDirs.push(tmpDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<!DOCTYPE html><html><body>503 Service Unavailable</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      )
    );

    const items = await nationalTablesAdapter.load({
      tier: 'core',
      cacheDir: tmpDir,
      offlineOnly: false,
      timeoutMs: 5000,
    });

    expect(items).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'national', 'cnf.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'national', 'ciqual.json'))).toBe(false);
  });

  test('nationalTablesAdapter.load auto-downloads valid Ciqual CSV, caches ciqual.json atomically, and returns parsed foods', async () => {
    const tmpDir = makeTempDir('national-autodl-');
    tempDirs.push(tmpDir);

    const sampleCiqual = [
      'alim_code;alim_nom_eng;alim_grp_nom_eng;Energy, Regulation EU No 1169/2011 (kcal/100g);Protein (g/100g);Carbohydrate (g/100g);Fat (g/100g);Fibres (g/100g);Sodium (mg/100g);Sugars (g/100g);Saturated fatty acids (g/100g)',
      '30001;Brie cheese;dairy;334;20,7;0,5;27,7;0;629;0,5;17,4',
    ].join('\n');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('data.gouv.fr')) {
          return new Response(sampleCiqual, {
            status: 200,
            headers: { 'content-type': 'text/csv; charset=utf-8' },
          });
        }
        return new Response('Not Found', { status: 404 });
      })
    );

    const items = await nationalTablesAdapter.load({
      tier: 'core',
      cacheDir: tmpDir,
      offlineOnly: false,
      timeoutMs: 5000,
    });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('ciqual:30001');
    expect(items[0].sourceProvider).toBe('ciqual');
    expect(items[0].nutrientsPerBasis.calories).toBe(334);
    expect(fs.existsSync(path.join(tmpDir, 'national', 'ciqual.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'national', 'ciqual.json.tmp'))).toBe(false);
  });
});
