/**
 * Cost Calculation Tools (4 tools)
 *
 * Standard cost, actual cost, component breakdown, and work center costs.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useClient } from '../services/odoo-pool.js';
import { calculateStandardCost, calculateActualCost } from '../services/cost-calculator.js';
import type { MrpWorkorder, MrpWorkcenter } from '../types.js';
import { MFG_FIELDS, ResponseFormat } from '../constants.js';
import {
  CalculateStandardCostSchema, GetActualMOCostSchema,
  CalculateComponentCostsSchema, GetWorkCenterCostsSchema,
  type CalculateStandardCostInput, type GetActualMOCostInput,
  type CalculateComponentCostsInput, type GetWorkCenterCostsInput,
} from '../schemas/index.js';
import {
  formatCurrency, formatDuration, formatVariance, formatVariancePercent,
  getVarianceStatusLabel, getRelationName,
} from '../services/formatters.js';

export function registerCostTools(server: McpServer): void {

  // ==========================================================================
  // Tool 6: calculate_standard_cost
  // ==========================================================================
  server.tool(
    'calculate_standard_cost',
    'Calculate standard (planned) cost for a product by rolling up BOM component prices and work center rates. Recursive for multi-level BOMs. Returns BOM cost tree with totals.',
    CalculateStandardCostSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = CalculateStandardCostSchema.parse(args) as CalculateStandardCostInput;

      try {
        return await useClient(async (client) => {
          const result = await calculateStandardCost(client, input.product_id, input.quantity, input.bom_id);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          let md = `## Standard Cost: ${result.root.product_name} (Qty: ${result.quantity})\n\n`;

          md += `| Component | Total |\n|-----------|-------|\n`;
          md += `| Materials | ${formatCurrency(result.total_material_cost)} |\n`;
          md += `| Labor & Overhead | ${formatCurrency(result.total_labor_cost)} |\n`;
          md += `| **Total Standard Cost** | **${formatCurrency(result.total_cost)}** |\n`;
          md += `| **Per Unit** | **${formatCurrency(result.per_unit_cost)}** |\n`;

          if (result.warnings.length > 0) {
            md += `\n### Warnings\n`;
            for (const w of result.warnings) md += `- ${w}\n`;
          }

          md += `\n### Key Findings\n`;
          md += `1. Standard cost for ${result.quantity} units of ${result.root.product_name} is **${formatCurrency(result.total_cost)}** (${formatCurrency(result.per_unit_cost)}/unit)\n`;
          if (result.total_labor_cost > 0) {
            const laborPercent = Math.round((result.total_labor_cost / result.total_cost) * 100);
            md += `2. Labor represents ${laborPercent}% of total cost\n`;
          }
          if (result.depth_reached > 1) {
            md += `3. BOM has ${result.depth_reached} levels of sub-assemblies\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error calculating standard cost: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 7: get_actual_mo_cost
  // ==========================================================================
  server.tool(
    'get_actual_mo_cost',
    'Get actual cost of a Manufacturing Order from stock move valuations (materials consumed) + work order durations × work center rates + scrap. Best for completed MOs. WIP MOs are flagged as estimates.',
    GetActualMOCostSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetActualMOCostSchema.parse(args) as GetActualMOCostInput;

      try {
        return await useClient(async (client) => {
          const result = await calculateActualCost(client, input.mo_id, input.include_scrap);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          let md = `## Actual Cost: ${result.mo_name}\n\n`;
          if (result.is_estimate) md += `**STATUS: ESTIMATE** — MO not yet completed\n\n`;

          md += `**Product:** ${result.product_name} | **Qty:** ${result.quantity} | **Good Units:** ${result.good_units}\n\n`;

          md += `| Category | Amount |\n|----------|--------|\n`;
          md += `| Materials | ${formatCurrency(result.material_cost)} |\n`;
          md += `| Labor | ${formatCurrency(result.labor_cost)} |\n`;
          if (result.scrap_cost > 0) md += `| Scrap | ${formatCurrency(result.scrap_cost)} |\n`;
          md += `| **Total Actual Cost** | **${formatCurrency(result.total_cost)}** |\n`;
          md += `| **Per Good Unit** | **${formatCurrency(result.per_unit_cost)}** |\n`;

          // Component breakdown
          if (result.components.length > 0) {
            md += `\n### Materials Consumed (${result.components.length})\n\n`;
            md += `| Component | Qty | Unit Cost | Total |\n`;
            md += `|-----------|-----|-----------|-------|\n`;
            for (const c of result.components) {
              md += `| ${c.product_name} | ${c.actual_qty.toFixed(2)} | ${formatCurrency(c.actual_price)} | ${formatCurrency(c.actual_cost)} |\n`;
            }
          }

          // Work order breakdown
          if (result.work_orders.length > 0) {
            md += `\n### Work Orders (${result.work_orders.length})\n\n`;
            md += `| Work Center | Expected | Actual | Cost |\n`;
            md += `|------------|----------|--------|------|\n`;
            for (const wo of result.work_orders) {
              md += `| ${wo.workcenter_name} | ${formatDuration(wo.expected_duration)} | ${formatDuration(wo.actual_duration)} | ${formatCurrency(wo.actual_cost)} |\n`;
            }
          }

          if (result.warnings.length > 0) {
            md += `\n### Warnings\n`;
            for (const w of result.warnings) md += `- ${w}\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error calculating actual cost: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 8: calculate_component_costs
  // ==========================================================================
  server.tool(
    'calculate_component_costs',
    'Per-component cost breakdown for a Manufacturing Order. Shows standard vs actual price, planned vs consumed quantity, and cost contribution percentage for each component.',
    CalculateComponentCostsSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = CalculateComponentCostsSchema.parse(args) as CalculateComponentCostsInput;

      try {
        return await useClient(async (client) => {
          const actual = await calculateActualCost(client, input.mo_id, true);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(actual.components, null, 2) }] };
          }

          let md = `## Component Costs: ${actual.mo_name}\n\n`;
          md += `**Total Material Cost:** ${formatCurrency(actual.material_cost)}\n\n`;

          if (actual.components.length === 0) {
            md += '_No consumed components found._\n';
          } else {
            md += `| Component | Qty | Std Price | Act Price | Act Cost | % of Total |\n`;
            md += `|-----------|-----|-----------|-----------|----------|------------|\n`;
            for (const c of actual.components) {
              const pctOfTotal = actual.material_cost > 0
                ? Math.round((c.actual_cost / actual.material_cost) * 100)
                : 0;
              md += `| ${c.product_name} | ${c.actual_qty.toFixed(2)} | ${formatCurrency(c.standard_price)} | ${formatCurrency(c.actual_price)} | ${formatCurrency(c.actual_cost)} | ${pctOfTotal}% |\n`;
            }
          }

          // Key findings
          md += `\n### Key Findings\n`;
          const sorted = [...actual.components].sort((a, b) => b.actual_cost - a.actual_cost);
          if (sorted.length > 0) {
            md += `1. **Largest cost driver:** ${sorted[0].product_name} at ${formatCurrency(sorted[0].actual_cost)}\n`;
          }
          const overpriced = actual.components.filter(c => c.standard_price > 0 && c.actual_price > c.standard_price * 1.1);
          if (overpriced.length > 0) {
            md += `2. **${overpriced.length} component(s) above standard price** by >10%: ${overpriced.map(c => c.product_name).join(', ')}\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error calculating component costs: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 9: get_work_center_costs
  // ==========================================================================
  server.tool(
    'get_work_center_costs',
    'Per-work-center cost breakdown for a Manufacturing Order. Shows expected vs actual duration, hourly rate, and cost variance for each work center/operation.',
    GetWorkCenterCostsSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetWorkCenterCostsSchema.parse(args) as GetWorkCenterCostsInput;

      try {
        return await useClient(async (client) => {
          const actual = await calculateActualCost(client, input.mo_id, false);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(actual.work_orders, null, 2) }] };
          }

          let md = `## Work Center Costs: ${actual.mo_name}\n\n`;
          md += `**Total Labor Cost:** ${formatCurrency(actual.labor_cost)}\n\n`;

          if (actual.work_orders.length === 0) {
            md += '_No work orders found (simplified production — material-only costing)._\n';
          } else {
            md += `| Work Center | Rate/h | Expected | Actual | Std Cost | Act Cost | Variance |\n`;
            md += `|------------|--------|----------|--------|----------|----------|----------|\n`;
            for (const wo of actual.work_orders) {
              const varianceLabel = getVarianceStatusLabel(
                wo.standard_cost > 0 ? ((wo.variance / wo.standard_cost) * 100) : 0
              );
              md += `| ${wo.workcenter_name} | ${formatCurrency(wo.costs_hour)} | ${formatDuration(wo.expected_duration)} | ${formatDuration(wo.actual_duration)} | ${formatCurrency(wo.standard_cost)} | ${formatCurrency(wo.actual_cost)} | ${formatVariance(wo.variance)} (${varianceLabel}) |\n`;
            }
          }

          // Key findings
          md += `\n### Key Findings\n`;
          const overTime = actual.work_orders.filter(wo => wo.actual_duration > wo.expected_duration * 1.1);
          const underTime = actual.work_orders.filter(wo => wo.actual_duration < wo.expected_duration * 0.9);
          if (overTime.length > 0) {
            md += `1. **${overTime.length} operation(s) over planned time:** ${overTime.map(wo => `${wo.workcenter_name} (${formatDuration(wo.actual_duration)} vs ${formatDuration(wo.expected_duration)} planned)`).join(', ')}\n`;
          }
          if (underTime.length > 0) {
            md += `2. **${underTime.length} operation(s) under planned time (efficient):** ${underTime.map(wo => wo.workcenter_name).join(', ')}\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error fetching work center costs: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}
