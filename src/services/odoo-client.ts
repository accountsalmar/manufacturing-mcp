/**
 * Odoo XML-RPC Client for Manufacturing MCP
 *
 * Read-only client for querying Odoo manufacturing data.
 * Adapted from crm-mcp with manufacturing-specific cached methods.
 */

import xmlrpc from 'xmlrpc';
const { createClient, createSecureClient } = xmlrpc;
type Client = ReturnType<typeof createClient>;
import type { OdooConfig, OdooRecord, MrpWorkcenter } from '../types.js';
import { withTimeout, TIMEOUTS, TimeoutError } from '../utils/timeout.js';
import { executeWithRetry } from '../utils/retry.js';
import { CIRCUIT_BREAKER_CONFIG, MFG_FIELDS } from '../constants.js';
import { cache, CACHE_TTL, CACHE_KEYS } from '../utils/cache.js';
import { CircuitBreaker, CircuitBreakerError, CircuitState, type CircuitBreakerMetrics } from '../utils/circuit-breaker.js';

export class OdooClient {
  private config: OdooConfig;
  private uid: number | null = null;
  private commonClient: Client;
  private objectClient: Client;
  private circuitBreaker: CircuitBreaker;

  constructor(config: OdooConfig, circuitBreaker?: CircuitBreaker) {
    this.config = config;

    this.circuitBreaker = circuitBreaker || new CircuitBreaker(
      CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD,
      CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS,
      CIRCUIT_BREAKER_CONFIG.HALF_OPEN_MAX_ATTEMPTS
    );

    const commonUrl = new URL('/xmlrpc/2/common', config.url);
    const objectUrl = new URL('/xmlrpc/2/object', config.url);

    const isSecure = config.url.startsWith('https');
    const clientFactory = isSecure ? createSecureClient : createClient;

    this.commonClient = clientFactory({
      host: commonUrl.hostname,
      port: isSecure ? 443 : (parseInt(commonUrl.port) || 80),
      path: commonUrl.pathname,
      headers: { 'Content-Type': 'text/xml' }
    });

    this.objectClient = clientFactory({
      host: objectUrl.hostname,
      port: isSecure ? 443 : (parseInt(objectUrl.port) || 80),
      path: objectUrl.pathname,
      headers: { 'Content-Type': 'text/xml' }
    });
  }

  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  async authenticate(): Promise<number> {
    if (this.uid !== null) {
      return this.uid;
    }

    try {
      const uid = await withTimeout(
        this._doAuthenticate(),
        TIMEOUTS.AUTH,
        'Odoo authentication timed out'
      );
      this.uid = uid;
      return uid;
    } catch (error) {
      if (error instanceof TimeoutError) {
        console.error('Authentication timeout:', error.message);
      }
      throw error;
    }
  }

  private _doAuthenticate(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.commonClient.methodCall(
        'authenticate',
        [this.config.db, this.config.username, this.config.password, {}],
        (error: unknown, value: unknown) => {
          if (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            reject(new Error(`Authentication failed: ${errMsg}`));
          } else if (value === false) {
            reject(new Error('Authentication failed: Invalid credentials'));
          } else {
            resolve(value as number);
          }
        }
      );
    });
  }

  // ============================================================================
  // CORE API METHODS
  // ============================================================================

  private async execute<T>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<T> {
    const uid = await this.authenticate();

    return this.circuitBreaker.execute(async () => {
      try {
        return await withTimeout(
          executeWithRetry(() => this._doExecute<T>(uid, model, method, args, kwargs)),
          TIMEOUTS.API,
          `Odoo API call timed out (${model}.${method})`
        );
      } catch (error) {
        if (error instanceof TimeoutError) {
          console.error('API timeout:', error.message);
        }
        throw error;
      }
    });
  }

  private _doExecute<T>(
    uid: number,
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.objectClient.methodCall(
        'execute_kw',
        [
          this.config.db,
          uid,
          this.config.password,
          model,
          method,
          args,
          kwargs
        ],
        (error: unknown, value: unknown) => {
          if (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            reject(new Error(`Odoo API error: ${errMsg}`));
          } else {
            resolve(value as T);
          }
        }
      );
    });
  }

  // Search and read records with pagination
  async searchRead<T extends OdooRecord>(
    model: string,
    domain: unknown[] = [],
    fields: string[] = [],
    options: {
      offset?: number;
      limit?: number;
      order?: string;
    } = {}
  ): Promise<T[]> {
    const { offset = 0, limit = 10, order = 'id desc' } = options;

    return this.execute<T[]>(model, 'search_read', [domain], {
      fields,
      offset,
      limit,
      order
    });
  }

  // Count records matching domain
  async searchCount(model: string, domain: unknown[] = []): Promise<number> {
    return this.execute<number>(model, 'search_count', [domain]);
  }

  // Read specific records by IDs
  async read<T extends OdooRecord>(
    model: string,
    ids: number[],
    fields: string[] = []
  ): Promise<T[]> {
    return this.execute<T[]>(model, 'read', [ids], { fields });
  }

  // Read grouped data for aggregation
  async readGroup(
    model: string,
    domain: unknown[] = [],
    fields: string[] = [],
    groupby: string[] = [],
    options: {
      offset?: number;
      limit?: number;
      orderby?: string;
      lazy?: boolean;
    } = {}
  ): Promise<Array<Record<string, unknown>>> {
    return this.execute<Array<Record<string, unknown>>>(
      model,
      'read_group',
      [domain, fields, groupby],
      {
        offset: options.offset,
        limit: options.limit,
        orderby: options.orderby,
        lazy: options.lazy ?? true
      }
    );
  }

  // Get model fields metadata
  async fieldsGet(
    model: string,
    attributes: string[] = ['string', 'type', 'required']
  ): Promise<Record<string, unknown>> {
    return this.execute<Record<string, unknown>>(
      model,
      'fields_get',
      [],
      { attributes }
    );
  }

  // ============================================================================
  // CACHED METHODS - Manufacturing reference data
  // ============================================================================

  /** Get work centers with caching (30 minute TTL) */
  async getWorkcentersCached(): Promise<MrpWorkcenter[]> {
    return cache.getWithRefresh(
      CACHE_KEYS.workcenters(),
      () => this.searchRead<MrpWorkcenter>(
        'mrp.workcenter',
        [['active', '=', true]],
        MFG_FIELDS.WORKCENTER_LIST as unknown as string[],
        { order: 'sequence asc', limit: 100 }
      ),
      CACHE_TTL.WORKCENTERS
    );
  }

  // ============================================================================
  // CACHE & CIRCUIT BREAKER MANAGEMENT
  // ============================================================================

  async invalidateCache(keys?: string[]): Promise<void> {
    if (keys) {
      await Promise.all(keys.map(key => cache.delete(key)));
    } else {
      await cache.clear();
    }
  }

  async getCacheStats(): Promise<{
    size: number;
    keys: string[];
    metrics: { hits: number; misses: number; hitRate: number }
  }> {
    const stats = await cache.stats();
    const metrics = cache.getMetrics();
    return { ...stats, metrics };
  }

  resetAuthCache(): void {
    this.uid = null;
  }

  getCircuitBreakerState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  getCircuitBreakerMetrics(): CircuitBreakerMetrics {
    return this.circuitBreaker.getMetrics();
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  /** Pre-populate cache with manufacturing reference data */
  async warmCache(): Promise<{ success: string[]; failed: string[] }> {
    const startTime = Date.now();
    const success: string[] = [];
    const failed: string[] = [];

    const results = await Promise.allSettled([
      this.getWorkcentersCached(),
    ]);

    const names = ['workcenters'];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        success.push(`${names[i]}(${(result.value as unknown[]).length})`);
      } else {
        failed.push(names[i]);
      }
    });

    const elapsed = Date.now() - startTime;
    console.error(`[MfgCache] Warmup: ${success.length}/${names.length} loaded in ${elapsed}ms`);
    if (success.length > 0) console.error(`  Loaded: ${success.join(', ')}`);
    if (failed.length > 0) console.error(`  Failed: ${failed.join(', ')}`);

    return { success, failed };
  }
}

// Singleton instance
let clientInstance: OdooClient | null = null;

export function getOdooClient(): OdooClient {
  if (!clientInstance) {
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

    clientInstance = new OdooClient(config);
  }

  return clientInstance;
}

export function resetOdooClient(): void {
  clientInstance = null;
}

export async function warmCache(): Promise<void> {
  try {
    const client = getOdooClient();
    await client.warmCache();
  } catch (error) {
    console.error('[MfgCache] Warmup failed:', error instanceof Error ? error.message : error);
  }
}
