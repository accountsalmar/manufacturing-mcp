/**
 * Variance Analysis Tools (4 tools)
 *
 * Compare standard vs actual costs and identify root causes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useClient } from '../services/odoo-pool.js';
import { calculateVariance, calculateActualCost } from '../services/cost-calculator.js';
import type { StockScrap } from '../types.js';
import { MFG_FIELDS, ResponseFormat } from '../constants.js';
import {
  AnalyzeCostVarianceSchema, GetMaterialVarianceSchema,
  GetLaborVarianceSchema, GetScrapImpactSchema,
  type AnalyzeCostVarianceInput, type GetMaterialVarianceInput,
  type GetLaborVarianceInput, type GetScrapImpactInput,
} from '../schemas/index.js';
import {
  formatCurrency, formatDuration, formatVariance, formatVariancePercent,
  getVarianceStatusLabel, getRelationName, formatPercent,
} from '../services/formatters.js';

export function registerVarianceTools(server: McpServer): void {

  // ==========================================================================
  // Tool 10: analyze_cost_variance
  // ==========================================================================
  server.tool(
    'analyze_cost_variance',
    'Full cost variance analysis for a Manufacturing Order. Produces three-part output: variance dashboard (Standard vs Actual by category), material/labor breakdown, and key findings with significance flags (>10% = SIGNIFICANT).',
    AnalyzeCostVarianceSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = AnalyzeCostVarianceSchema.parse(args) as AnalyzeCostVarianceInput;

      try {
        return await useClient(async (client) => {
          const result = await calculateVariance(client, input.mo_id);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          let md = `## Cost Variance Analysis: ${result.mo_name}\n\n`;
          md += `**Product:** ${result.product_name}\n`;
          if (result.actual.is_estimate) md += `**STATUS: ESTIMATE** — MO not yet completed\n`;
          md += '\n';

          // Part 2: Variance Dashboard
          md += `### Variance Dashboard\n\n`;
          md += `| Category | Standard | Actual | Variance | Var % | Status |\n`;
          md += `|----------|----------|--------|----------|-------|--------|\n`;
          md += `| Materials | ${formatCurrency(result.material_variance.standard_cost)} | ${formatCurrency(result.material_variance.actual_cost)} | ${formatVariance(result.material_variance.variance)} | ${formatVariancePercent(result.material_variance.variance_percent)} | ${getVarianceStatusLabel(result.material_variance.variance_percent)} |\n`;
          md += `| Labor | ${formatCurrency(result.labor_variance.standard_cost)} | ${formatCurrency(result.labor_variance.actual_cost)} | ${formatVariance(result.labor_variance.variance)} | ${formatVariancePercent(result.labor_variance.variance_percent)} | ${getVarianceStatusLabel(result.labor_variance.variance_percent)} |\n`;
          if (result.scrap_impact.total_scrap_cost > 0) {
            md += `| Scrap | - | ${formatCurrency(result.scrap_impact.total_scrap_cost)} | ${formatVariance(result.scrap_impact.total_scrap_cost)} | - | ${result.scrap_impact.scrap_rate > 5 ? 'WARNING' : 'OK'} |\n`;
          }
          md += `| **TOTAL** | **${formatCurrency(result.total_variance.standard_cost)}** | **${formatCurrency(result.total_variance.actual_cost)}** | **${formatVariance(result.total_variance.variance)}** | **${formatVariancePercent(result.total_variance.variance_percent)}** | **${getVarianceStatusLabel(result.total_variance.variance_percent)}** |\n`;

          // Key findings
          md += `\n### Key Findings\n\n`;
          const findings: string[] = [];

          if (result.is_significant) {
            findings.push(`**Total variance is SIGNIFICANT at ${formatVariancePercent(result.total_variance.variance_percent)}** (${formatVariance(result.total_variance.variance)}). Requires management review.`);
          }

          // Biggest component variance
          const sortedComponents = [...result.component_variances].sort((a, b) => Math.abs(b.total_variance) - Math.abs(a.total_variance));
          if (sortedComponents.length > 0 && Math.abs(sortedComponents[0].total_variance) > 0) {
            const top = sortedComponents[0];
            findings.push(`**Largest material variance:** ${top.product_name} at ${formatVariance(top.total_variance)} (Price: ${formatVariance(top.price_variance)}, Qty: ${formatVariance(top.quantity_variance)})`);
          }

          // Labor efficiency
          const inefficient = result.labor_variances.filter(lv => lv.efficiency_variance > 0);
          if (inefficient.length > 0) {
            findings.push(`**${inefficient.length} work center(s) over planned time:** ${inefficient.map(lv => `${lv.workcenter_name} (${formatVariance(lv.efficiency_variance)})`).join(', ')}`);
          }

          if (result.scrap_impact.scrap_rate > 0) {
            findings.push(`**Scrap rate:** ${result.scrap_impact.scrap_rate.toFixed(1)}% — adds ${formatCurrency(result.scrap_impact.per_unit_impact)} per good unit`);
          }

          if (result.total_variance.favorable) {
            findings.push(`**Overall favorable** — actual cost was ${formatCurrency(Math.abs(result.total_variance.variance))} under standard`);
          }

          for (let i = 0; i < Math.min(findings.length, 5); i++) {
            md += `${i + 1}. ${findings[i]}\n`;
          }

          if (result.warnings.length > 0) {
            md += `\n### Warnings\n`;
            for (const w of result.warnings) md += `- ${w}\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error analyzing variance: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 11: get_material_variance
  // ==========================================================================
  server.tool(
    'get_material_variance',
    'Per-component material variance breakdown. Shows price variance (paid more/less per unit) and quantity variance (used more/less than planned) for each component.',
    GetMaterialVarianceSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetMaterialVarianceSchema.parse(args) as GetMaterialVarianceInput;

      try {
        return await useClient(async (client) => {
          const result = await calculateVariance(client, input.mo_id);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(result.component_variances, null, 2) }] };
          }

          let md = `## Material Variance: ${result.mo_name}\n\n`;
          md += `**Total Material Variance:** ${formatVariance(result.material_variance.variance)} (${formatVariancePercent(result.material_variance.variance_percent)})\n\n`;

          if (result.component_variances.length === 0) {
            md += '_No component variance data available._\n';
          } else {
            md += `| Component | Price Var | Qty Var | Total Var |\n`;
            md += `|-----------|-----------|---------|----------|\n`;
            for (const cv of result.component_variances) {
              md += `| ${cv.product_name} | ${formatVariance(cv.price_variance)} | ${formatVariance(cv.quantity_variance)} | ${formatVariance(cv.total_variance)} |\n`;
            }
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 12: get_labor_variance
  // ==========================================================================
  server.tool(
    'get_labor_variance',
    'Per-work-center labor variance breakdown. Shows rate variance (cost more/less per hour) and efficiency variance (took more/less time than planned).',
    GetLaborVarianceSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetLaborVarianceSchema.parse(args) as GetLaborVarianceInput;

      try {
        return await useClient(async (client) => {
          const result = await calculateVariance(client, input.mo_id);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(result.labor_variances, null, 2) }] };
          }

          let md = `## Labor Variance: ${result.mo_name}\n\n`;
          md += `**Total Labor Variance:** ${formatVariance(result.labor_variance.variance)} (${formatVariancePercent(result.labor_variance.variance_percent)})\n\n`;

          if (result.labor_variances.length === 0) {
            md += '_No work order data available (simplified production)._\n';
          } else {
            md += `| Work Center | Rate Var | Efficiency Var | Total Var |\n`;
            md += `|------------|----------|----------------|----------|\n`;
            for (const lv of result.labor_variances) {
              md += `| ${lv.workcenter_name} | ${formatVariance(lv.rate_variance)} | ${formatVariance(lv.efficiency_variance)} | ${formatVariance(lv.total_variance)} |\n`;
            }
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 13: get_scrap_impact
  // ==========================================================================
  server.tool(
    'get_scrap_impact',
    'Scrap cost analysis for a Manufacturing Order. Shows scrapped quantity, cost, per-unit impact (divided by GOOD units), and scrap rate percentage.',
    GetScrapImpactSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetScrapImpactSchema.parse(args) as GetScrapImpactInput;

      try {
        return await useClient(async (client) => {
          const actual = await calculateActualCost(client, input.mo_id, true);

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify({ scrap_records: actual.scrap_records, scrap_cost: actual.scrap_cost, per_unit_impact: actual.good_units > 0 ? actual.scrap_cost / actual.good_units : 0, scrap_rate: actual.quantity > 0 ? ((actual.quantity - actual.good_units) / actual.quantity) * 100 : 0, good_units: actual.good_units, total_produced: actual.quantity }, null, 2) }] };
          }

          const scrapRate = actual.quantity > 0 ? ((actual.quantity - actual.good_units) / actual.quantity) * 100 : 0;
          const perUnitImpact = actual.good_units > 0 ? actual.scrap_cost / actual.good_units : 0;

          let md = `## Scrap Impact: ${actual.mo_name}\n\n`;

          md += `| Metric | Value |\n|--------|-------|\n`;
          md += `| Total Produced | ${actual.quantity} |\n`;
          md += `| Good Units | ${actual.good_units} |\n`;
          md += `| Scrapped | ${actual.quantity - actual.good_units} |\n`;
          md += `| Scrap Rate | ${scrapRate.toFixed(1)}% |\n`;
          md += `| Total Scrap Cost | ${formatCurrency(actual.scrap_cost)} |\n`;
          md += `| Per Good Unit Impact | ${formatCurrency(perUnitImpact)} |\n`;

          if (actual.scrap_records.length > 0) {
            md += `\n### Scrap Records\n\n`;
            for (const scrap of actual.scrap_records) {
              md += `- ${getRelationName(scrap.product_id)}: ${scrap.scrap_qty} units (${scrap.state || '-'})\n`;
            }
          } else {
            md += '\n_No scrap recorded for this MO._\n';
          }

          md += `\n### Key Findings\n`;
          if (scrapRate === 0) {
            md += `1. **Zero scrap** — no material waste recorded\n`;
          } else if (scrapRate <= 5) {
            md += `1. Scrap rate ${scrapRate.toFixed(1)}% is within acceptable range (<5%)\n`;
          } else if (scrapRate <= 15) {
            md += `1. **Scrap rate ${scrapRate.toFixed(1)}% exceeds warning threshold (5%).** Review production process.\n`;
          } else {
            md += `1. **CRITICAL: Scrap rate ${scrapRate.toFixed(1)}% exceeds 15%.** Immediate investigation required.\n`;
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}
