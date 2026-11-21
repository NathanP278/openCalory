import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { mapUsdaFoodToFoodItem } from '../src/lib/foods/usda-adapter';
import type { FoodItem } from '../src/types/nutrition';

const FOUNDATION_ZIP_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2024-10-31.zip';
const SR_LEGACY_ZIP_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip';

const TARGET_STAPLES_COUNT = 2500;

async function downloadFileIfNotExists(url: string, destPath: string): Promise<void> {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    console.log(`Using cached download: ${destPath}`);
    return;
  }
  console.log(`Downloading ${url} -> ${destPath}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  console.log(`Saved ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB to ${destPath}`);
}

function extractZip(zipPath: string, outputDir: string): void {
  console.log(`Extracting ${zipPath} into ${outputDir}...`);
  try {
    execSync(`unzip -q -o "${zipPath}" -d "${outputDir}"`, { stdio: 'inherit' });
  } catch {
    // Fallback to tar if unzip command fails
    execSync(`tar -xf "${zipPath}" -C "${outputDir}"`, { stdio: 'inherit' });
  }
}

const ALLOWED_CATEGORIES = new Set([
  'Vegetables and Vegetable Products',
  'Fruits and Fruit Juices',
  'Dairy and Egg Products',
  'Poultry Products',
  'Beef Products',
  'Pork Products',
  'Finfish and Shellfish Products',
  'Legumes and Legume Products',
  'Nut and Seed Products',
  'Cereal Grains and Pasta',
  'Spices and Herbs',
  'Fats and Oils',
]);

const PRIORITY_WORDS = [
  'raw',
  'cooked',
  'boiled',
  'roasted',
  'fresh',
  'steamed',
  'dried',
  'baked',
  'broiled',
  'whole',
  'breast',
  'egg',
  'rice',
  'apple',
  'banana',
  'beef',
  'chicken',
  'pork',
  'fish',
  'salmon',
  'tuna',
  'milk',
  'cheese',
  'yogurt',
  'potato',
  'oat',
  'bread',
  'bean',
  'lentil',
  'nut',
  'almond',
  'peanut',
  'spinach',
  'broccoli',
  'carrot',
  'onion',
  'tomato',
  'avocado',
  'oil',
];

function scoreSrFood(item: any): number {
  const desc = (item.description || '').toLowerCase();
  let score = 0;
  for (const w of PRIORITY_WORDS) {
    if (desc.includes(w)) score += 10;
  }
  // Penalize excessively long/verbose descriptions
  score -= Math.floor(desc.length / 10);
  return score;
}

export async function buildStaples(): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), 'opencalory-usda');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const foundationZip = path.join(tmpDir, 'foundation.zip');
  const srLegacyZip = path.join(tmpDir, 'sr_legacy.zip');

  await downloadFileIfNotExists(FOUNDATION_ZIP_URL, foundationZip);
  await downloadFileIfNotExists(SR_LEGACY_ZIP_URL, srLegacyZip);

  // Find or extract Foundation JSON
  let foundationJsonPath = path.join(tmpDir, 'foundationDownload.json');
  if (!fs.existsSync(foundationJsonPath)) {
    extractZip(foundationZip, tmpDir);
  }

  // Find or extract SR Legacy JSON
  let srLegacyJsonPath = path.join(tmpDir, 'FoodData_Central_sr_legacy_food_json_2018-04.json');
  if (!fs.existsSync(srLegacyJsonPath)) {
    extractZip(srLegacyZip, tmpDir);
  }

  console.log('Reading Foundation Foods dataset...');
  const foundationRaw = JSON.parse(fs.readFileSync(foundationJsonPath, 'utf8'));
  const foundationFoods: any[] = foundationRaw.FoundationFoods || [];
  console.log(`Loaded ${foundationFoods.length} Foundation foods.`);

  console.log('Reading SR Legacy Foods dataset...');
  const srLegacyRaw = JSON.parse(fs.readFileSync(srLegacyJsonPath, 'utf8'));
  const srLegacyFoods: any[] = srLegacyRaw.SRLegacyFoods || [];
  console.log(`Loaded ${srLegacyFoods.length} SR Legacy foods.`);

  // Map all Foundation foods first (highest analytical fidelity)
  const foundationMapped: FoodItem[] = foundationFoods.map((f) =>
    mapUsdaFoodToFoodItem(f, 'staple')
  );

  // Filter SR Legacy foods for clean whole food categories
  const srCandidates = srLegacyFoods.filter((f) => {
    const cat = f.foodCategory?.description || '';
    if (!ALLOWED_CATEGORIES.has(cat)) return false;
    const desc = (f.description || '').toLowerCase();
    if (
      desc.includes('babyfood') ||
      desc.includes('alcoholic') ||
      desc.includes('candy') ||
      desc.includes('infant')
    ) {
      return false;
    }
    return true;
  });

  // Rank SR candidates by relevance to staple diets
  srCandidates.sort((a, b) => scoreSrFood(b) - scoreSrFood(a));

  const neededSr = Math.max(0, TARGET_STAPLES_COUNT - foundationMapped.length);
  const srSelected = srCandidates.slice(0, neededSr).map((f) =>
    mapUsdaFoodToFoodItem(f, 'staple')
  );

  const curatedStaples: FoodItem[] = [...foundationMapped, ...srSelected];

  // Set fixed deterministic timestamp for reproducibility
  for (const item of curatedStaples) {
    item.updatedAt = 1700000000000;
  }

  console.log(`Curated ${curatedStaples.length} staples (${foundationMapped.length} Foundation + ${srSelected.length} SR Legacy).`);

  const publicDataDir = path.resolve(process.cwd(), 'public/data');
  if (!fs.existsSync(publicDataDir)) {
    fs.mkdirSync(publicDataDir, { recursive: true });
  }

  const outputPath = path.join(publicDataDir, 'staples-2500.json');
  fs.writeFileSync(outputPath, JSON.stringify(curatedStaples, null, 2), 'utf8');

  const stats = fs.statSync(outputPath);
  console.log(`Wrote ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);
}

// Direct CLI execution
buildStaples().catch((err) => {
  console.error('Failed to build staples:', err);
  process.exit(1);
});

