/**
 * Cache Provider Interface
 *
 * Common interface for cache backends.
 * All methods return Promises for future Redis compatibility.
 */

export interface CacheEntry<T> {
  data: T;
  createdAt: number;
  expiresAt: number;
}

export interface CacheStats {
  size: number;
  keys: string[];
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
}

export interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, data: T, ttlMs: number): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  getWithRefresh<T>(
    key: string,
    refreshFn: () => Promise<T>,
    ttlMs: number,
    refreshThresholdPercent?: number
  ): Promise<T>;
  stats(): Promise<CacheStats>;
  getMetrics(): CacheMetrics;
  resetMetrics(): void;
}
