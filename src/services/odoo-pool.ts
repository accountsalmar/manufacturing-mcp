/**
 * Connection Pool Manager for OdooClient instances
 *
 * Pre-creates and manages a pool of authenticated Odoo clients.
 * Recommended usage: useClient() for automatic acquire/release.
 */

import { createPool, Pool, type Options, type Factory } from 'generic-pool';
import { OdooClient } from './odoo-client.js';
import { getSharedCircuitBreaker, getSharedCircuitBreakerState } from './shared-circuit-breaker.js';
import { POOL_CONFIG } from '../constants.js';
import type { OdooConfig } from '../types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface PoolMetrics {
  size: number;
  available: number;
  borrowed: number;
  pending: number;
  min: number;
  max: number;
}

// ============================================================================
// POOL SINGLETON
// ============================================================================

let pool: Pool<OdooClient> | null = null;

function getOdooConfig(): OdooConfig {
  const config: OdooConfig = {
    url: process.env.ODOO_URL || 'http://localhost:8069',
    db: process.env.ODOO_DB || 'odoo',
    username: process.env.ODOO_USERNAME || 'admin',
    password: process.env.ODOO_PASSWORD || 'admin'
  };

  if (!config.url || !config.db || !config.username || !config.password) {
    throw new Error(
      'Missing Odoo configuration. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD environment variables.'
    );
  }

  return config;
}

function createClientFactory(config: OdooConfig): Factory<OdooClient> {
  const sharedBreaker = getSharedCircuitBreaker();

  return {
    create: async (): Promise<OdooClient> => {
      console.error('[Pool] Creating new OdooClient...');
      const client = new OdooClient(config, sharedBreaker);

      try {
        await client.authenticate();
        console.error('[Pool] OdooClient created and authenticated');
      } catch (error) {
        console.error('[Pool] OdooClient authentication failed:',
          error instanceof Error ? error.message : error);
        throw error;
      }

      return client;
    },

    destroy: async (client: OdooClient): Promise<void> => {
      console.error('[Pool] Destroying OdooClient');
      client.resetAuthCache();
    },

    validate: async (_client: OdooClient): Promise<boolean> => {
      const cbState = getSharedCircuitBreakerState();
      if (cbState === 'OPEN') {
        console.error('[Pool] Validation failed: Circuit breaker is OPEN');
        return false;
      }
      return true;
    }
  };
}

export function getPool(): Pool<OdooClient> {
  if (!pool) {
    const config = getOdooConfig();
    const factory = createClientFactory(config);

    const poolOptions: Options = {
      min: POOL_CONFIG.MIN,
      max: POOL_CONFIG.MAX,
      acquireTimeoutMillis: POOL_CONFIG.ACQUIRE_TIMEOUT_MS,
      idleTimeoutMillis: POOL_CONFIG.IDLE_TIMEOUT_MS,
      evictionRunIntervalMillis: POOL_CONFIG.EVICTION_RUN_INTERVAL_MS,
      testOnBorrow: POOL_CONFIG.TEST_ON_BORROW,
      fifo: POOL_CONFIG.FIFO,
    };

    pool = createPool(factory, poolOptions);

    console.error(`[Pool] Initialized (min=${POOL_CONFIG.MIN}, max=${POOL_CONFIG.MAX})`);

    pool.on('factoryCreateError', (err) => {
      console.error('[Pool] Factory create error:', err instanceof Error ? err.message : err);
    });

    pool.on('factoryDestroyError', (err) => {
      console.error('[Pool] Factory destroy error:', err instanceof Error ? err.message : err);
    });
  }

  return pool;
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function acquireClient(): Promise<OdooClient> {
  const p = getPool();
  return p.acquire();
}

export async function releaseClient(client: OdooClient): Promise<void> {
  const p = getPool();
  await p.release(client);
}

export async function destroyClient(client: OdooClient): Promise<void> {
  const p = getPool();
  await p.destroy(client);
}

/** Use a client with automatic acquire/release (RECOMMENDED) */
export async function useClient<T>(
  callback: (client: OdooClient) => Promise<T>
): Promise<T> {
  const client = await acquireClient();
  try {
    return await callback(client);
  } finally {
    await releaseClient(client);
  }
}

// ============================================================================
// MONITORING & MANAGEMENT
// ============================================================================

export function getPoolMetrics(): PoolMetrics {
  const p = getPool();
  return {
    size: p.size,
    available: p.available,
    borrowed: p.borrowed,
    pending: p.pending,
    min: p.min,
    max: p.max,
  };
}

export async function drainPool(): Promise<void> {
  if (pool) {
    console.error('[Pool] Draining pool...');
    await pool.drain();
    await pool.clear();
    pool = null;
    console.error('[Pool] Pool drained and cleared');
  }
}

export async function resetPool(): Promise<void> {
  await drainPool();
}

/** Warm the pool by pre-creating minimum clients */
export async function warmPool(): Promise<{ success: number; failed: number }> {
  console.error('[Pool] Warming pool...');
  const startTime = Date.now();

  let success = 0;
  let failed = 0;

  try {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < POOL_CONFIG.MIN; i++) {
      promises.push(
        acquireClient()
          .then(async (client) => {
            await releaseClient(client);
            success++;
          })
          .catch((err) => {
            console.error(`[Pool] Warm-up client ${i + 1} failed:`,
              err instanceof Error ? err.message : err);
            failed++;
          })
      );
    }

    await Promise.all(promises);
  } catch (err) {
    console.error('[Pool] Warm-up encountered error (non-fatal):',
      err instanceof Error ? err.message : err);
    failed = POOL_CONFIG.MIN;
  }

  const elapsed = Date.now() - startTime;
  console.error(`[Pool] Warm-up complete: ${success} ready, ${failed} failed (${elapsed}ms)`);

  return { success, failed };
}
