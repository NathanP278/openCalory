import Dexie, { type Table } from 'dexie';
import type {
  FoodItem,
  FoodLogEntry,
  CustomRecipe,
  UserGoals,
  WeightLogEntry,
  PinnedFood,
  SyncTombstone,
} from '@/types/nutrition';
import { createCentralSyncMiddleware } from './cloud-sync';

export class OpenCaloryDB extends Dexie {
  foodLogs!: Table<FoodLogEntry, string>;
  foodsCache!: Table<FoodItem, string>;
  customRecipes!: Table<CustomRecipe, string>;
  userGoals!: Table<UserGoals, string>;
  weightLogs!: Table<WeightLogEntry, string>;
  pinnedFoods!: Table<PinnedFood, string>;
  tombstones!: Table<SyncTombstone, string>;

  constructor() {
    super('openCaloryDB');
    this.version(1).stores({
      foodLogs: 'id, date, mealSlot, foodId, createdAt',
      foodsCache: 'id, barcode, source, name, updatedAt',
      customRecipes: 'id, name, createdAt',
      userGoals: 'id, updatedAt',
    });
    this.version(2).stores({
      weightLogs: 'id, date, createdAt, updatedAt',
      pinnedFoods: 'id, kind, pinnedAt',
      tombstones: 'id, tableName, deletedAt',
    });
    this.use(createCentralSyncMiddleware(() => this));
  }
}

export const generateId = (): string => crypto.randomUUID();

export const db = new OpenCaloryDB();
