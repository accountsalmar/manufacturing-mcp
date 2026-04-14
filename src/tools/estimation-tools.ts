/**
 * Pre-Production Estimation Tools (3 tools)
 *
 * Estimate costs before manufacturing, compare BOMs, and run what-if scenarios.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useClient } from '../services/odoo-pool.js';
import { calculateStandardCost } from '../services/cost-calculator.js';
import { explodeBom } from '../services/bom-service.js';
import type { BomExplosionResult, BomNode } from '../types.js';
import { ResponseFormat } from '../constants.js';
import {
  EstimateProductionCostSchema, CompareBomVersionsSchema, WhatIfAnalysisSchema,
  type EstimateProductionCostInput, type CompareBomVersionsInput, type WhatIfAnalysisInput,
} from '../schemas/index.js';
import { formatCurrency, formatVariance, formatVariancePercent } from '../services/formatters.js';

export function registerEstimationTools(server: McpServer): void {

  // ==========================================================================
  // Tool 14: estimate_production_cost
  // ==========================================================================
  server.tool(
    'estimate_production_cost',
    'Estimate the cost of manufacturing a product BEFORE creating a Manufacturing Order. Uses current BOM and standard prices. Input: product_id + quantity. No MO needed.',
    EstimateProductionCostSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = EstimateProductionCostSchema.parse(args) as EstimateProductionCostInput;

      try {
        return await useClient(async (client) => {
          const result = await calculateStandardCost(client, input.product_id, input.quantity, input.bom_id);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          let md = `## Production Cost Estimate: ${result.root.product_name}\n\n`;
          md += `**Quantity:** ${result.quantity} | **BOM ID:** ${result.root.bom_id}\n\n`;

          md += `| Category | Amount | Per Unit |\n`;
          md += `|----------|--------|----------|\n`;
          md += `| Materials | ${formatCurrency(result.total_material_cost)} | ${formatCurrency(result.total_material_cost / result.quantity)} |\n`;
          md += `| Labor & Overhead | ${formatCurrency(result.total_labor_cost)} | ${formatCurrency(result.total_labor_cost / result.quantity)} |\n`;
          md += `| **Total Estimate** | **${formatCurrency(result.total_cost)}** | **${formatCurrency(result.per_unit_cost)}** |\n`;

          md += `\n*This is an estimate based on current standard prices and BOM. Actual costs may vary.*\n`;

          if (result.warnings.length > 0) {
            md += `\n### Warnings\n`;
            for (const w of result.warnings) md += `- ${w}\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error estimating cost: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 15: compare_bom_versions
  // ==========================================================================
  server.tool(
    'compare_bom_versions',
    'Compare cost between two BOMs for the same or different products. Shows component differences and total cost impact side-by-side.',
    CompareBomVersionsSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = CompareBomVersionsSchema.parse(args) as CompareBomVersionsInput;

      try {
        return await useClient(async (client) => {
          const [resultA, resultB] = await Promise.all([
            explodeBom(client, input.bom_id_a, input.quantity),
            explodeBom(client, input.bom_id_b, input.quantity),
          ]);

          const delta = resultB.total_cost - resultA.total_cost;
          const deltaPct = resultA.total_cost !== 0 ? (delta / resultA.total_cost) * 100 : 0;

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify({ bom_a: resultA, bom_b: resultB, delta, delta_percent: deltaPct }, null, 2) }] };
          }

          let md = `## BOM Comparison (Qty: ${input.quantity})\n\n`;

          md += `| Metric | BOM A (${input.bom_id_a}) | BOM B (${input.bom_id_b}) | Delta |\n`;
          md += `|--------|------|------|-------|\n`;
          md += `| Product | ${resultA.root.product_name} | ${resultB.root.product_name} | - |\n`;
          md += `| Materials | ${formatCurrency(resultA.total_material_cost)} | ${formatCurrency(resultB.total_material_cost)} | ${formatVariance(resultB.total_material_cost - resultA.total_material_cost)} |\n`;
          md += `| Labor | ${formatCurrency(resultA.total_labor_cost)} | ${formatCurrency(resultB.total_labor_cost)} | ${formatVariance(resultB.total_labor_cost - resultA.total_labor_cost)} |\n`;
          md += `| **Total** | **${formatCurrency(resultA.total_cost)}** | **${formatCurrency(resultB.total_cost)}** | **${formatVariance(delta)}** (${formatVariancePercent(deltaPct)}) |\n`;
          md += `| Per Unit | ${formatCurrency(resultA.per_unit_cost)} | ${formatCurrency(resultB.per_unit_cost)} | ${formatVariance(resultB.per_unit_cost - resultA.per_unit_cost)} |\n`;

          md += `\n### Key Findings\n`;
          if (Math.abs(deltaPct) < 1) {
            md += `1. BOMs are nearly identical in cost (${formatVariancePercent(deltaPct)} difference)\n`;
          } else if (delta > 0) {
            md += `1. **BOM B costs ${formatVariance(delta)} more** (${formatVariancePercent(deltaPct)}) than BOM A\n`;
          } else {
            md += `1. **BOM B saves ${formatCurrency(Math.abs(delta))}** (${formatVariancePercent(Math.abs(deltaPct))}) compared to BOM A\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error comparing BOMs: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 16: what_if_analysis
  // ==========================================================================
  server.tool(
    'what_if_analysis',
    'What-if cost scenario: change component price, quantity, labor rate, or production quantity and see the cost impact vs baseline. Overrides are applied to the BOM tree without modifying Odoo data.',
    WhatIfAnalysisSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = WhatIfAnalysisSchema.parse(args) as WhatIfAnalysisInput;

      try {
        return await useClient(async (client) => {
          // Get baseline
          const baseline = await calculateStandardCost(client, input.product_id, input.quantity, input.bom_id);

          // Deep clone for scenario
          const scenario = JSON.parse(JSON.stringify(baseline)) as BomExplosionResult;

          // Apply overrides
          const appliedOverrides: string[] = [];
          for (const override of input.overrides) {
            if (override.type === 'component_price' && override.target_id) {
              const updated = updateNodePrice(scenario.root, override.target_id, override.new_value);
              if (updated) appliedOverrides.push(`Component ${override.target_id} price → ${formatCurrency(override.new_value)}`);
            } else if (override.type === 'component_qty' && override.target_id) {
              const updated = updateNodeQty(scenario.root, override.target_id, override.new_value);
              if (updated) appliedOverrides.push(`Component ${override.target_id} qty → ${override.new_value}`);
            } else if (override.type === 'labor_rate' && override.target_id) {
              for (const op of scenario.root.operations) {
                if (op.workcenter_id === override.target_id) {
                  op.costs_hour = override.new_value;
                  op.operation_cost = (op.duration_expected / 60) * override.new_value;
                  appliedOverrides.push(`WC ${op.workcenter_name} rate → ${formatCurrency(override.new_value)}/h`);
                }
              }
            }
          }

          // Recalculate scenario totals
          scenario.total_material_cost = recalcLeafCosts(scenario.root);
          scenario.total_labor_cost = scenario.root.operations.reduce((s, op) => s + op.operation_cost, 0);
          scenario.total_cost = scenario.total_material_cost + scenario.total_labor_cost;
          scenario.per_unit_cost = scenario.quantity > 0 ? scenario.total_cost / scenario.quantity : 0;

          const delta = scenario.total_cost - baseline.total_cost;
          const deltaPct = baseline.total_cost !== 0 ? (delta / baseline.total_cost) * 100 : 0;

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify({ baseline_cost: baseline.total_cost, scenario_cost: scenario.total_cost, delta, delta_percent: deltaPct, overrides_applied: appliedOverrides }, null, 2) }] };
          }

          let md = `## What-If Analysis: ${baseline.root.product_name}\n\n`;
          md += `### Overrides Applied\n`;
          for (const o of appliedOverrides) md += `- ${o}\n`;
          md += '\n';

          md += `| Metric | Baseline | Scenario | Delta |\n`;
          md += `|--------|----------|----------|-------|\n`;
          md += `| Materials | ${formatCurrency(baseline.total_material_cost)} | ${formatCurrency(scenario.total_material_cost)} | ${formatVariance(scenario.total_material_cost - baseline.total_material_cost)} |\n`;
          md += `| Labor | ${formatCurrency(baseline.total_labor_cost)} | ${formatCurrency(scenario.total_labor_cost)} | ${formatVariance(scenario.total_labor_cost - baseline.total_labor_cost)} |\n`;
          md += `| **Total** | **${formatCurrency(baseline.total_cost)}** | **${formatCurrency(scenario.total_cost)}** | **${formatVariance(delta)}** (${formatVariancePercent(deltaPct)}) |\n`;
          md += `| Per Unit | ${formatCurrency(baseline.per_unit_cost)} | ${formatCurrency(scenario.per_unit_cost)} | ${formatVariance(scenario.per_unit_cost - baseline.per_unit_cost)} |\n`;

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in what-if analysis: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}

// =============================================================================
// HELPERS for what-if
// =============================================================================

function updateNodePrice(node: BomNode, productId: number, newPrice: number): boolean {
  if (node.product_id === productId && node.is_leaf) {
    node.standard_price = newPrice;
    node.line_cost = node.quantity * newPrice;
    return true;
  }
  for (const child of node.children) {
    if (updateNodePrice(child, productId, newPrice)) return true;
  }
  return false;
}

function updateNodeQty(node: BomNode, productId: number, newQty: number): boolean {
  if (node.product_id === productId && node.is_leaf) {
    node.quantity = newQty;
    node.line_cost = newQty * node.standard_price;
    return true;
  }
  for (const child of node.children) {
    if (updateNodeQty(child, productId, newQty)) return true;
  }
  return false;
}

function recalcLeafCosts(node: BomNode): number {
  if (node.is_leaf) return node.line_cost;
  let total = 0;
  for (const child of node.children) {
    total += recalcLeafCosts(child);
  }
  node.line_cost = total;
  return total;
}
