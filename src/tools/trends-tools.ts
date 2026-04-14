/**
 * Trends & Comparison Tools (3 tools)
 *
 * Historical cost trends, MO performance comparison, and work center efficiency.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useClient } from '../services/odoo-pool.js';
import { calculateActualCost } from '../services/cost-calculator.js';
import type { MrpProduction, MrpWorkorder } from '../types.js';
import { MFG_FIELDS, ResponseFormat } from '../constants.js';
import {
  GetCostTrendsSchema, CompareMOPerformanceSchema, GetEfficiencySummarySchema,
  type GetCostTrendsInput, type CompareMOPerformanceInput, type GetEfficiencySummaryInput,
} from '../schemas/index.js';
import { formatCurrency, formatDate, formatDuration, formatVariance, formatVariancePercent, getRelationName, formatPercent } from '../services/formatters.js';

export function registerTrendsTools(server: McpServer): void {

  // ==========================================================================
  // Tool 17: get_cost_trends
  // ==========================================================================
  server.tool(
    'get_cost_trends',
    'Cost per unit over time for a product across completed Manufacturing Orders. Group by weekly, monthly, or quarterly. Shows standard vs actual trend to identify cost drift.',
    GetCostTrendsSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetCostTrendsSchema.parse(args) as GetCostTrendsInput;

      try {
        return await useClient(async (client) => {
          const domain: unknown[] = [
            ['product_id', '=', input.product_id],
            ['state', '=', 'done'],
          ];
          if (input.date_from) domain.push(['date_finished', '>=', input.date_from]);
          if (input.date_to) domain.push(['date_finished', '<=', input.date_to]);

          const mos = await client.searchRead<MrpProduction>(
            'mrp.production', domain,
            ['id', 'name', 'product_id', 'product_qty', 'std_cost', 'mo_cost', 'date_finished'],
            { order: 'date_finished asc', limit: 200 }
          );

          if (mos.length === 0) {
            return { content: [{ type: 'text', text: `No completed Manufacturing Orders found for product ID ${input.product_id}.` }] };
          }

          // Group by period
          const periods = new Map<string, { count: number; total_std: number; total_actual: number; total_qty: number }>();

          for (const mo of mos) {
            const date = mo.date_finished || '';
            const periodKey = getPeriodKey(date, input.granularity);

            const existing = periods.get(periodKey) || { count: 0, total_std: 0, total_actual: 0, total_qty: 0 };
            existing.count++;
            existing.total_std += mo.std_cost || 0;
            existing.total_actual += mo.mo_cost || 0;
            existing.total_qty += mo.product_qty || 0;
            periods.set(periodKey, existing);
          }

          const productName = mos[0].product_id ? (mos[0].product_id as [number, string])[1] : 'Unknown';

          if (input.response_format === ResponseFormat.JSON) {
            const data = Array.from(periods.entries()).map(([period, v]) => ({
              period, ...v,
              std_per_unit: v.total_qty > 0 ? v.total_std / v.total_qty : 0,
              actual_per_unit: v.total_qty > 0 ? v.total_actual / v.total_qty : 0,
            }));
            return { content: [{ type: 'text', text: JSON.stringify({ product: productName, granularity: input.granularity, periods: data }, null, 2) }] };
          }

          let md = `## Cost Trends: ${productName} (${input.granularity})\n\n`;
          md += `| Period | MOs | Qty | Std/Unit | Actual/Unit | Variance |\n`;
          md += `|--------|-----|-----|----------|-------------|----------|\n`;

          for (const [period, v] of periods) {
            const stdPerUnit = v.total_qty > 0 ? v.total_std / v.total_qty : 0;
            const actPerUnit = v.total_qty > 0 ? v.total_actual / v.total_qty : 0;
            const variance = actPerUnit - stdPerUnit;
            md += `| ${period} | ${v.count} | ${v.total_qty} | ${formatCurrency(stdPerUnit)} | ${formatCurrency(actPerUnit)} | ${formatVariance(variance)} |\n`;
          }

          md += `\n### Key Findings\n`;
          const periodArr = Array.from(periods.entries());
          if (periodArr.length >= 2) {
            const first = periodArr[0];
            const last = periodArr[periodArr.length - 1];
            const firstActual = first[1].total_qty > 0 ? first[1].total_actual / first[1].total_qty : 0;
            const lastActual = last[1].total_qty > 0 ? last[1].total_actual / last[1].total_qty : 0;
            const trendDelta = lastActual - firstActual;
            md += `1. Cost trend from ${first[0]} to ${last[0]}: ${formatVariance(trendDelta)} per unit\n`;
          }
          md += `2. Total MOs analyzed: ${mos.length} across ${periods.size} periods\n`;

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 18: compare_mo_performance
  // ==========================================================================
  server.tool(
    'compare_mo_performance',
    'Compare a specific Manufacturing Order against the historical average for the same product. Shows whether this MO performed better or worse than typical, with ranking.',
    CompareMOPerformanceSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = CompareMOPerformanceSchema.parse(args) as CompareMOPerformanceInput;

      try {
        return await useClient(async (client) => {
          // Get the target MO
          const mos = await client.read<MrpProduction>(
            'mrp.production', [input.mo_id],
            ['id', 'name', 'product_id', 'product_qty', 'std_cost', 'mo_cost', 'state']
          );
          if (!mos.length) return { content: [{ type: 'text', text: `MO ID ${input.mo_id} not found.` }], isError: true };
          const mo = mos[0];

          const productId = mo.product_id ? (mo.product_id as [number, string])[0] : 0;
          const productName = mo.product_id ? (mo.product_id as [number, string])[1] : 'Unknown';
          const moPerUnit = (mo.mo_cost || 0) / (mo.product_qty || 1);

          // Get historical MOs for same product
          const historicalMOs = await client.searchRead<MrpProduction>(
            'mrp.production',
            [['product_id', '=', productId], ['state', '=', 'done'], ['id', '!=', mo.id]],
            ['id', 'name', 'product_qty', 'mo_cost'],
            { order: 'date_finished desc', limit: 50 }
          );

          if (historicalMOs.length === 0) {
            return { content: [{ type: 'text', text: `No historical MOs found for product "${productName}" to compare against.` }] };
          }

          // Calculate averages
          const costs = historicalMOs.map(h => (h.mo_cost || 0) / (h.product_qty || 1)).filter(c => c > 0);
          const avgPerUnit = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
          const minPerUnit = costs.length > 0 ? Math.min(...costs) : 0;
          const maxPerUnit = costs.length > 0 ? Math.max(...costs) : 0;

          // Rank this MO
          const allCosts = [...costs, moPerUnit].sort((a, b) => a - b);
          const rank = allCosts.indexOf(moPerUnit) + 1;
          const percentile = Math.round((rank / allCosts.length) * 100);

          const vsAvg = moPerUnit - avgPerUnit;
          const vsAvgPct = avgPerUnit > 0 ? (vsAvg / avgPerUnit) * 100 : 0;

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify({ mo: mo.name, product: productName, this_mo_per_unit: moPerUnit, avg_per_unit: avgPerUnit, min_per_unit: minPerUnit, max_per_unit: maxPerUnit, vs_avg: vsAvg, vs_avg_pct: vsAvgPct, rank, total_compared: allCosts.length, percentile }, null, 2) }] };
          }

          let md = `## MO Performance: ${mo.name}\n\n`;
          md += `**Product:** ${productName} | **Compared against:** ${historicalMOs.length} historical MOs\n\n`;

          md += `| Metric | This MO | Historical Avg | Delta |\n`;
          md += `|--------|---------|---------------|-------|\n`;
          md += `| Cost/Unit | ${formatCurrency(moPerUnit)} | ${formatCurrency(avgPerUnit)} | ${formatVariance(vsAvg)} (${formatVariancePercent(vsAvgPct)}) |\n`;
          md += `| Best | - | ${formatCurrency(minPerUnit)} | - |\n`;
          md += `| Worst | - | ${formatCurrency(maxPerUnit)} | - |\n`;

          md += `\n**Rank:** ${rank} of ${allCosts.length} (${percentile}th percentile — ${percentile <= 25 ? 'top performer' : percentile <= 75 ? 'average' : 'below average'})\n`;

          md += `\n### Key Findings\n`;
          if (vsAvg < 0) {
            md += `1. **This MO performed better than average** — ${formatCurrency(Math.abs(vsAvg))}/unit below historical average\n`;
          } else if (vsAvg > 0) {
            md += `1. **This MO cost more than average** — ${formatCurrency(vsAvg)}/unit above historical average\n`;
          } else {
            md += `1. This MO matched the historical average exactly\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 19: get_efficiency_summary
  // ==========================================================================
  server.tool(
    'get_efficiency_summary',
    'Work center efficiency summary: planned vs actual hours, cost efficiency percentage, and utilization trends. Filter by work center and date range.',
    GetEfficiencySummarySchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetEfficiencySummarySchema.parse(args) as GetEfficiencySummaryInput;

      try {
        return await useClient(async (client) => {
          const domain: unknown[] = [['state', '=', 'done']];
          if (input.workcenter_id) domain.push(['workcenter_id', '=', input.workcenter_id]);
          if (input.date_from) domain.push(['date_finished', '>=', input.date_from]);
          if (input.date_to) domain.push(['date_finished', '<=', input.date_to]);

          // Use readGroup for aggregation
          const groups = await client.readGroup(
            'mrp.workorder',
            domain,
            ['workcenter_id', 'duration_expected:sum', 'duration:sum', '__count'],
            ['workcenter_id']
          );

          if (groups.length === 0) {
            return { content: [{ type: 'text', text: 'No completed work orders found for the given criteria.' }] };
          }

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(groups, null, 2) }] };
          }

          let md = `## Work Center Efficiency Summary\n\n`;

          md += `| Work Center | Planned Hours | Actual Hours | Efficiency | Status |\n`;
          md += `|------------|--------------|-------------|------------|--------|\n`;

          for (const g of groups) {
            const wcName = Array.isArray(g.workcenter_id) ? (g.workcenter_id as [number, string])[1] : String(g.workcenter_id || 'Unknown');
            const planned = (g['duration_expected'] as number || 0) / 60;
            const actual = (g['duration'] as number || 0) / 60;
            const efficiency = planned > 0 ? (planned / actual) * 100 : 0;
            const count = g['__count'] as number || g['workcenter_id_count'] as number || 0;
            const status = efficiency >= 95 ? 'EFFICIENT' : efficiency >= 80 ? 'OK' : 'NEEDS REVIEW';

            md += `| ${wcName} (${count} WOs) | ${planned.toFixed(1)}h | ${actual.toFixed(1)}h | ${efficiency.toFixed(0)}% | ${status} |\n`;
          }

          md += `\n### Key Findings\n`;
          const inefficient = groups.filter(g => {
            const planned = (g['duration_expected'] as number || 0);
            const actual = (g['duration'] as number || 0);
            return actual > planned * 1.2;
          });
          if (inefficient.length > 0) {
            md += `1. **${inefficient.length} work center(s) running >20% over planned time** — review operations\n`;
          } else {
            md += `1. All work centers within acceptable efficiency range\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}

// =============================================================================
// HELPERS
// =============================================================================

function getPeriodKey(dateStr: string, granularity: string): string {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);

  switch (granularity) {
    case 'weekly': {
      const startOfWeek = new Date(date);
      startOfWeek.setDate(date.getDate() - date.getDay());
      return `W${startOfWeek.toISOString().slice(0, 10)}`;
    }
    case 'monthly':
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    case 'quarterly': {
      const quarter = Math.ceil((date.getMonth() + 1) / 3);
      return `${date.getFullYear()}-Q${quarter}`;
    }
    default:
      return dateStr.slice(0, 10);
  }
}
