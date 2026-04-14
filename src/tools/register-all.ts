/**
 * Master tool registration for Manufacturing MCP Server.
 * Registers all tools across all categories.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useClient, getPoolMetrics } from '../services/odoo-pool.js';
import { getSharedCircuitBreakerMetrics } from '../services/shared-circuit-breaker.js';
import { cache } from '../utils/cache.js';
import { HealthCheckSchema, type HealthCheckInput } from '../schemas/index.js';
import { ResponseFormat } from '../constants.js';
import { registerKnowledgeTools } from './knowledge-tools.js';
import { registerDiscoveryTools } from './discovery-tools.js';
import { registerCostTools } from './cost-tools.js';
import { registerVarianceTools } from './variance-tools.js';
import { registerEstimationTools } from './estimation-tools.js';
import { registerTrendsTools } from './trends-tools.js';

export function registerAllTools(server: McpServer): void {
  // ============================================================================
  // HEALTH CHECK TOOL
  // ============================================================================
  server.tool(
    'odoo_mfg_health_check',
    'Check Manufacturing MCP server health: Odoo connectivity, pool metrics, cache stats, circuit breaker state.',
    HealthCheckSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = HealthCheckSchema.parse(args);

      try {
        // Test Odoo connectivity
        let odooStatus = 'unknown';
        let odooLatency = 0;
        try {
          const start = Date.now();
          await useClient(async (client) => {
            await client.searchCount('mrp.production', []);
          });
          odooLatency = Date.now() - start;
          odooStatus = 'connected';
        } catch (error) {
          odooStatus = `error: ${error instanceof Error ? error.message : String(error)}`;
        }

        // Gather metrics
        const poolMetrics = getPoolMetrics();
        const cbMetrics = getSharedCircuitBreakerMetrics();
        const cacheStats = await cache.stats();
        const cacheMetrics = cache.getMetrics();

        const healthData = {
          status: odooStatus === 'connected' ? 'healthy' : 'degraded',
          server: 'odoo-manufacturing-mcp-server',
          version: '1.0.0',
          odoo: {
            status: odooStatus,
            latency_ms: odooLatency,
          },
          pool: poolMetrics,
          circuit_breaker: cbMetrics,
          cache: {
            ...cacheStats,
            metrics: cacheMetrics,
          },
        };

        if (input.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: 'text', text: JSON.stringify(healthData, null, 2) }],
          };
        }

        // Markdown format
        const md = [
          `## Manufacturing MCP Health Check`,
          '',
          `**Status:** ${healthData.status}`,
          `**Server:** ${healthData.server} v${healthData.version}`,
          '',
          `### Odoo Connection`,
          `- **Status:** ${odooStatus}`,
          `- **Latency:** ${odooLatency}ms`,
          '',
          `### Connection Pool`,
          `- **Size:** ${poolMetrics.size} (min: ${poolMetrics.min}, max: ${poolMetrics.max})`,
          `- **Available:** ${poolMetrics.available}`,
          `- **In Use:** ${poolMetrics.borrowed}`,
          `- **Pending:** ${poolMetrics.pending}`,
          '',
          `### Circuit Breaker`,
          `- **State:** ${cbMetrics.state}`,
          `- **Failures:** ${cbMetrics.failureCount}`,
          `- **Successes:** ${cbMetrics.successCount}`,
          cbMetrics.secondsUntilHalfOpen !== null
            ? `- **Retry in:** ${cbMetrics.secondsUntilHalfOpen}s`
            : '',
          '',
          `### Cache`,
          `- **Entries:** ${cacheStats.size}`,
          `- **Hit Rate:** ${cacheMetrics.hitRate}% (${cacheMetrics.hits} hits, ${cacheMetrics.misses} misses)`,
        ].filter(Boolean).join('\n');

        return { content: [{ type: 'text', text: md }] };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Health check failed: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true,
        };
      }
    }
  );

  // Knowledge & Configuration (2 tools)
  registerKnowledgeTools(server);

  // Discovery & Lookup (5 tools)
  registerDiscoveryTools(server);

  // Cost Calculation (4 tools)
  registerCostTools(server);

  // Variance Analysis (4 tools)
  registerVarianceTools(server);

  // Pre-Production Estimation (3 tools)
  registerEstimationTools(server);

  // Trends & Comparison (3 tools)
  registerTrendsTools(server);
}
