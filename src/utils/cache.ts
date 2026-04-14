/**
 * Cache Factory - Exports the active cache provider
 *
 * Memory-only implementation (no Redis needed for single-instance deployment).
 *
 * Usage:
 *   import { cache, CACHE_TTL, CACHE_KEYS } from './utils/cache.js';
 *   const data = await cache.get<MyType>('key');
 */

import type { CacheProvider } from './cache-interface.js';
import { MemoryCache, CACHE_TTL, CACHE_KEYS, CACHE_CONFIG } from './cache-memory.js';

let cacheInstance: CacheProvider | null = null;

export function getCache(): CacheProvider {
  if (!cacheInstance) {
    console.error('[Cache] Using memory cache');
    cacheInstance = new MemoryCache();
  }
  return cacheInstance;
}

export function resetCache(): void {
  cacheInstance = null;
}

export const cache = getCache();

export { CACHE_TTL, CACHE_KEYS, CACHE_CONFIG };
export type { CacheProvider, CacheEntry, CacheStats, CacheMetrics } from './cache-interface.js';
