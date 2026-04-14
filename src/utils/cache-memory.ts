/**
 * In-memory cache implementation with LRU eviction
 *
 * Features:
 * - LRU eviction when max size reached
 * - Stale-while-revalidate pattern for background refresh
 * - Type-safe with generics
 */

import { LRUCache } from 'lru-cache';
import type { CacheProvider, CacheEntry, CacheStats, CacheMetrics } from './cache-interface.js';

export const CACHE_CONFIG = {
  MAX_SIZE: 500,
} as const;

export class MemoryCache implements CacheProvider {
  private cache: LRUCache<string, CacheEntry<unknown>>;
  private hits: number = 0;
  private misses: number = 0;
  private refreshingKeys: Set<string> = new Set();

  constructor() {
    this.cache = new LRUCache({
      max: CACHE_CONFIG.MAX_SIZE,
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.data as T;
  }

  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    const now = Date.now();
    this.cache.set(key, {
      data,
      createdAt: now,
      expiresAt: now + ttlMs
    });
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  async getWithRefresh<T>(
    key: string,
    refreshFn: () => Promise<T>,
    ttlMs: number,
    refreshThresholdPercent: number = 80
  ): Promise<T> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    const now = Date.now();

    if (entry) {
      const refreshThreshold = entry.createdAt + (ttlMs * refreshThresholdPercent / 100);

      if (now < refreshThreshold) {
        this.hits++;
        return entry.data;
      }

      if (now < entry.expiresAt) {
        this.hits++;

        if (!this.refreshingKeys.has(key)) {
          this.refreshingKeys.add(key);
          refreshFn()
            .then(freshData => this.set(key, freshData, ttlMs))
            .catch(err => console.error(`[MemoryCache] Background refresh failed for ${key}:`, err))
            .finally(() => this.refreshingKeys.delete(key));
        }

        return entry.data;
      }

      this.cache.delete(key);
    }

    this.misses++;
    const freshData = await refreshFn();
    await this.set(key, freshData, ttlMs);
    return freshData;
  }

  clearExpired(): number {
    const now = Date.now();
    let cleared = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  async stats(): Promise<CacheStats> {
    this.clearExpired();
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  getMetrics(): CacheMetrics {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? Math.round((this.hits / total) * 100) : 0;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate
    };
  }

  resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
  }
}

// Manufacturing-specific cache TTL constants (in milliseconds)
export const CACHE_TTL = {
  WORKCENTERS: 30 * 60 * 1000,      // 30 minutes - work centers rarely change
  BOM: 15 * 60 * 1000,              // 15 minutes - BOMs change occasionally
  PRODUCTS: 15 * 60 * 1000,         // 15 minutes - product costs may update
  BOM_EXPLOSION: 10 * 60 * 1000,    // 10 minutes - recursive BOM results
  FIELD_METADATA: 60 * 60 * 1000,   // 1 hour - model fields never change at runtime
} as const;

// Manufacturing-specific cache key generators
export const CACHE_KEYS = {
  workcenters: () => 'mfg:workcenters',
  bom: (bomId: number) => `mfg:bom:${bomId}`,
  bomExplosion: (bomId: number, quantity: number) => `mfg:bom_explosion:${bomId}:${quantity}`,
  products: (ids: string) => `mfg:products:${ids}`,
  productCost: (productId: number) => `mfg:product_cost:${productId}`,
  fieldMetadata: (model: string) => `mfg:fields:${model}`,
} as const;
