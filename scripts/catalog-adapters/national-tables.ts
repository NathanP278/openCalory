import fs from 'node:fs';
import path from 'node:path';
import type { MacroNutrients, Micronutrients } from '@/types/nutrition';
import type { CatalogFoodInput } from '@/lib/foods/catalog-schema';
import { cleanFoodDisplayName, generateFoodAliases } from '@/lib/foods/name-normalizer';
import { enrichServingOptions } from '@/lib/foods/portion-enrichment';
import {
  type AdapterLoadOptions,
  type CatalogAdapter,
  computeSearchRank,
  passesMacroQualityGate,
  round2,
} from './types';

export type NationalTableId =
  | 'cnf'
  | 'cofid'
  | 'ausnut'
  | 'mext'
  | 'bls'
  | 'ciqual'
  | 'nevo'
  | 'frida'
  | 'livsmedelsverket'
  | 'taco'
  | 'indb';

export interface NationalTableDefinition {
  id: NationalTableId;
  name: string;
  region: string;
  license: string;
  fileCandidates: string[];
}

export const NATIONAL_TABLE_SOURCES: NationalTableDefinition[] = [
  {
    id: 'cnf',
    name: 'Canadian Nutrient File (Health Canada)',
    region: 'CA',
    license: 'Open Government Licence – Canada',
    fileCandidates: ['cnf.json', 'cnf.csv'],
  },
  {
    id: 'cofid',
    name: 'UK McCance & Widdowson CoFID',
    region: 'GB',
    license: 'Open Government Licence v3.0',
    fileCandidates: ['cofid.json', 'cofid.csv'],
  },
  {
    id: 'ausnut',
    name: 'FSANZ AUSNUT / Australian Food Composition Database',
    region: 'AU',
    license: 'CC BY 4.0',
    fileCandidates: ['ausnut.json', 'ausnut.csv'],
  },
  {
    id: 'mext',
    name: 'Japan MEXT Standard Tables of Food Composition',
    region: 'JP',
    license: 'CC BY 4.0 / Japanese Government Open Data',
    fileCandidates: ['mext.json', 'mext.csv'],
  },
  {
    id: 'bls',
    name: 'Germany Bundeslebensmittelschlüssel (BLS 4.0)',
    region: 'DE',
    license: 'CC BY 4.0',
    fileCandidates: ['bls.json', 'bls.csv'],
  },
  {
    id: 'ciqual',
    name: 'France ANSES-Ciqual Food Composition Table',
    region: 'FR',
    license: 'Licence Ouverte / Open Licence v2.0',
    fileCandidates: ['ciqual.json', 'ciqual.csv'],
  },
  {
    id: 'nevo',
    name: 'Netherlands RIVM NEVO Table',
    region: 'NL',
    license: 'CC0 / Public Domain',
    fileCandidates: ['nevo.json', 'nevo.csv'],
  },
  {
    id: 'frida',
    name: 'Denmark DTU Food Frida Database',
    region: 'DK',
    license: 'CC BY 4.0',
    fileCandidates: ['frida.json', 'frida.csv'],
  },
  {
    id: 'livsmedelsverket',
    name: 'Sweden Livsmedelsverket Food Database',
    region: 'SE',
    license: 'CC BY 4.0 / Public Data',
    fileCandidates: ['livsmedelsverket.json', 'livsmedelsverket.csv'],
  },
  {
    id: 'taco',
    name: 'Brazil TBCA / TACO (NEPA-UNICAMP)',
    region: 'BR',
    license: 'Open Academic / CC BY',
    fileCandidates: ['taco.json', 'tbca.json', 'taco.csv'],
  },
  {
    id: 'indb',
    name: 'India Anuvaad INDB / NIN IFCT',
    region: 'IN',
    license: 'CC BY 4.0',
    fileCandidates: ['indb.json', 'ifct.json', 'indb.csv'],
  },
];

const TABLE_MAP = new Map<NationalTableId, NationalTableDefinition>(
  NATIONAL_TABLE_SOURCES.map((def) => [def.id, def])
);

const FIXED_TIMESTAMP = 1700000000000;

function toNum(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(',', '.');
    if (!cleaned || cleaned === 'Tr' || cleaned === '-' || cleaned === 'N') return 0;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickField(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return undefined;
}

/**
 * Pure row parser for any of the 11 national food composition tables.
 */
export function parseNationalTableRows(
  tableId: NationalTableId,
  rows: Record<string, unknown>[]
): CatalogFoodInput[] {
  const def = TABLE_MAP.get(tableId);
  if (!def) return [];

  const results: CatalogFoodInput[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;

    const rawNameVal = pickField(row, [
      'name',
      'food_name',
      'FoodName',
      'alim_nom_eng',
      'alim_nom_fr',
      'description',
      'Description',
    ]);
    const rawName = typeof rawNameVal === 'string' ? rawNameVal.trim() : '';
    if (!rawName) continue;

    const rawIdVal = pickField(row, ['id', 'food_code', 'FoodCode', 'alim_code', 'code']);
    const rawId = rawIdVal != null ? String(rawIdVal).trim() : `${i + 1}`;

    const calories = toNum(
      pickField(row, ['calories', 'energy_kcal', 'kcal', 'Energy (kcal)', 'enerc_kcal'])
    );
    const protein = toNum(pickField(row, ['protein', 'Protein', 'protein_g', 'protcnt']));
    const carbs = toNum(
      pickField(row, ['carbs', 'carbohydrates', 'Carbohydrate', 'carb_g', 'chocdf'])
    );
    const fat = toNum(pickField(row, ['fat', 'total_fat', 'Fat', 'fat_g', 'fatce']));
    const fiber = toNum(pickField(row, ['fiber', 'fibre', 'dietary_fiber', 'fibtg']));

    const nutrientsPerBasis: MacroNutrients = {
      calories: round2(calories),
      protein: round2(protein),
      carbs: round2(carbs),
      fat: round2(fat),
      fiber: round2(fiber),
    };

    if (!passesMacroQualityGate(nutrientsPerBasis, 1)) continue;

    const micros: Micronutrients = {};
    const microMap: Array<[keyof Micronutrients, string[]]> = [
      ['sodiumMg', ['sodiumMg', 'sodium_mg', 'sodium']],
      ['potassiumMg', ['potassiumMg', 'potassium_mg', 'potassium']],
      ['calciumMg', ['calciumMg', 'calcium_mg', 'calcium']],
      ['ironMg', ['ironMg', 'iron_mg', 'iron']],
      ['sugarG', ['sugarG', 'sugar_g', 'sugars']],
      ['saturatedFatG', ['saturatedFatG', 'saturated_fat_g', 'saturated_fat']],
      ['cholesterolMg', ['cholesterolMg', 'cholesterol_mg', 'cholesterol']],
    ];
    for (const [microKey, candidates] of microMap) {
      const val = toNum(pickField(row, candidates));
      if (val > 0) {
        micros[microKey] = round2(val);
      }
    }

    const categoryVal = pickField(row, ['category', 'food_group', 'group', 'alim_grp_nom_eng']);
    const category = typeof categoryVal === 'string' && categoryVal.trim() ? categoryVal.trim() : undefined;

    const cleanName = cleanFoodDisplayName(rawName);
    if (!cleanName) continue;

    const existingAliases = Array.isArray(row.aliases)
      ? row.aliases.filter((a): a is string => typeof a === 'string')
      : undefined;
    const aliases = generateFoodAliases(rawName, cleanName, existingAliases);

    const servingOptions = enrichServingOptions({
      name: cleanName,
      category,
      basis: 'per100g',
    });

    const record: CatalogFoodInput = {
      id: `${tableId}:${rawId}`,
      barcode: null,
      source: 'catalog',
      sourceProvider: tableId,
      accuracyTier: 1,
      region: def.region,
      ...(category ? { category } : {}),
      name: cleanName,
      ...(aliases.length > 0 ? { aliases } : {}),
      basis: 'per100g',
      servingSize: 100,
      servingUnit: 'g',
      servingOptions,
      nutrientsPerBasis,
      micronutrientsPerBasis: micros,
      updatedAt: FIXED_TIMESTAMP,
    };

    record.searchRank = computeSearchRank(record);
    results.push(record);
  }

  return results;
}

function detectDelimiter(headerLine: string): ',' | ';' | '\t' {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;

  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch === '"') {
      if (inQuotes && headerLine[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes) {
      if (ch === ',') commas++;
      else if (ch === ';') semicolons++;
      else if (ch === '\t') tabs++;
    }
  }

  if (tabs > commas && tabs >= semicolons) return '\t';
  if (semicolons > commas) return ';';
  return ',';
}

/**
 * RFC-4180 delimited parser supporting configurable delimiter (comma, semicolon, tab),
 * quoted fields with embedded delimiters/newlines, escaped double-quotes (""), and UTF-8 BOM.
 */
export function parseRfc4180Delimited(
  text: string,
  delimiter?: ',' | ';' | '\t'
): string[][] {
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (!clean.trim()) return [];

  const firstNewline = clean.search(/\r?\n/);
  const headerSample = firstNewline === -1 ? clean : clean.slice(0, firstNewline);
  const sep = delimiter ?? detectDelimiter(headerSample);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];

    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }

    if (ch === sep) {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((c) => c.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      field = '';
      continue;
    }

    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim().length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Parses a national-table CSV/TSV/semicolon-delimited text into row objects using RFC-4180 parsing.
 */
export function parseNationalTableCsv(
  csvText: string,
  delimiter?: ',' | ';' | '\t'
): Record<string, unknown>[] {
  const parsedRows = parseRfc4180Delimited(csvText, delimiter);
  if (parsedRows.length < 2) return [];

  const headers = parsedRows[0].map((h) => h.trim());
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < parsedRows.length; i++) {
    const vals = parsedRows[i];
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = (vals[idx] ?? '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

export const nationalTablesAdapter: CatalogAdapter = {
  id: 'national-tables',
  name: 'National Food Composition Tables (CNF, CoFID, AUSNUT, MEXT, BLS, Ciqual, NEVO, Frida, Livsmedelsverket, TACO, INDB)',
  license: 'Public Domain / CC BY 4.0 / Open Government',
  async load(options: AdapterLoadOptions): Promise<CatalogFoodInput[]> {
    const nationalDir = path.join(options.cacheDir, 'national');
    const results: CatalogFoodInput[] = [];

    if (!fs.existsSync(nationalDir)) {
      console.log(
        `[national-tables] No cached national table files in ${nationalDir} — skipping (place cached JSON/CSV files there to compile them).`
      );
      return results;
    }

    for (const def of NATIONAL_TABLE_SOURCES) {
      let foundFile: string | null = null;
      for (const candidate of def.fileCandidates) {
        const full = path.join(nationalDir, candidate);
        if (fs.existsSync(full)) {
          foundFile = full;
          break;
        }
      }

      if (!foundFile) {
        console.log(`[national-tables] ${def.id} (${def.region}) not cached — skipping.`);
        continue;
      }

      try {
        const rawText = fs.readFileSync(foundFile, 'utf8');
        let rows: Record<string, unknown>[] = [];
        if (foundFile.endsWith('.json')) {
          const parsed = JSON.parse(rawText);
          rows = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.foods)
              ? parsed.foods
              : [];
        } else {
          rows = parseNationalTableCsv(rawText);
        }
        const items = parseNationalTableRows(def.id, rows);
        console.log(`[national-tables] Loaded ${items.length} foods from ${def.id} (${def.region})`);
        results.push(...items);
      } catch (err) {
        console.warn(
          `[national-tables] Failed parsing ${foundFile}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return results;
  },
};
