/**
 * Knowledge & Configuration Tools (2 tools)
 *
 * Serves domain rules and output format specifications from JSON files.
 * No Odoo connection required — these are standalone knowledge tools.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GetCostMethodologySchema, GetOutputFormatSchema, type GetCostMethodologyInput, type GetOutputFormatInput } from '../schemas/index.js';
import { ResponseFormat } from '../constants.js';

// Resolve knowledge directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const knowledgeDir = join(__dirname, '..', 'knowledge');

// Lazy-loaded knowledge data
let methodologyData: Record<string, unknown> | null = null;
let outputFormatData: Record<string, unknown> | null = null;

function loadMethodology(): Record<string, unknown> {
  if (!methodologyData) {
    const filePath = join(knowledgeDir, 'cost-methodology.json');
    methodologyData = JSON.parse(readFileSync(filePath, 'utf-8'));
    console.error('[Knowledge] Loaded cost-methodology.json');
  }
  return methodologyData!;
}

function loadOutputFormat(): Record<string, unknown> {
  if (!outputFormatData) {
    const filePath = join(knowledgeDir, 'output-format.json');
    outputFormatData = JSON.parse(readFileSync(filePath, 'utf-8'));
    console.error('[Knowledge] Loaded output-format.json');
  }
  return outputFormatData!;
}

export function registerKnowledgeTools(server: McpServer): void {

  // ==========================================================================
  // Tool 1: get_cost_methodology
  // ==========================================================================
  server.tool(
    'get_cost_methodology',
    'Returns manufacturing cost analysis methodology: calculation rules, BOM explosion rules, variance formulas, data quality guards, workflow guidance, accounting guardrails, and terminology glossary. Adapts terminology to detail_level. Call this first to understand the domain rules before analyzing costs.',
    GetCostMethodologySchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetCostMethodologySchema.parse(args) as GetCostMethodologyInput;

      try {
        const data = loadMethodology();
        const rules = data.global_methodology_rules as Array<Record<string, unknown>>;
        const terminology = data.terminology as Record<string, Record<string, string>>;

        let result: Record<string, unknown>;

        if (input.section === 'all') {
          // Return everything, with terminology adapted to detail_level
          result = {
            ...data,
            terminology: terminology[input.detail_level] || terminology['detailed'],
          };
        } else {
          // Filter by section
          const sectionMap: Record<string, string> = {
            cost_rules: 'cost_rules',
            bom_rules: 'bom_rules',
            variance_rules: 'variance_rules',
            data_guards: 'data_guards',
            workflow: 'workflow',
            accounting: 'accounting',
            glossary: 'glossary',
          };

          if (input.section === 'glossary') {
            result = {
              terminology: terminology[input.detail_level] || terminology['detailed'],
            };
          } else if (input.section === 'workflow') {
            result = {
              workflow_guidance: data.workflow_guidance,
            };
          } else {
            const category = sectionMap[input.section];
            const filteredRules = rules.filter(r => r.category === category);
            result = {
              section: input.section,
              rules: filteredRules,
              terminology: terminology[input.detail_level] || terminology['detailed'],
            };
          }
        }

        const text = input.response_format === ResponseFormat.JSON
          ? JSON.stringify(result, null, 2)
          : formatMethodologyMarkdown(result, input.detail_level, input.section);

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error loading cost methodology: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================================================
  // Tool 2: get_output_format
  // ==========================================================================
  server.tool(
    'get_output_format',
    'Returns the three-part output format specification for manufacturing cost analysis: BOM tree format, variance dashboard format, key findings format, and detail level rules. Use this to understand how to structure cost analysis responses.',
    GetOutputFormatSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetOutputFormatSchema.parse(args) as GetOutputFormatInput;

      try {
        const data = loadOutputFormat();

        let result: Record<string, unknown>;

        if (input.section === 'all') {
          result = data;
        } else {
          const sectionMap: Record<string, string> = {
            bom_tree: 'bom_tree_format',
            variance_dashboard: 'variance_dashboard_format',
            key_findings: 'key_findings_format',
            detail_levels: 'detail_level_rules',
          };
          const key = sectionMap[input.section];
          result = { [input.section]: (data as Record<string, unknown>)[key] };
        }

        const text = input.response_format === ResponseFormat.JSON
          ? JSON.stringify(result, null, 2)
          : formatOutputFormatMarkdown(result, input.section);

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error loading output format: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

// =============================================================================
// MARKDOWN FORMATTERS
// =============================================================================

function formatMethodologyMarkdown(
  data: Record<string, unknown>,
  detailLevel: string,
  section: string
): string {
  const lines: string[] = ['## Manufacturing Cost Methodology', ''];

  if (section === 'glossary' || section === 'all') {
    const terms = data.terminology as Record<string, string> | undefined;
    if (terms) {
      lines.push('### Terminology', '');
      for (const [term, definition] of Object.entries(terms)) {
        lines.push(`- **${term}**: ${definition}`);
      }
      lines.push('');
    }
  }

  const rules = (data.global_methodology_rules || data.rules) as Array<Record<string, unknown>> | undefined;
  if (rules && rules.length > 0) {
    lines.push('### Rules', '');
    for (const rule of rules) {
      lines.push(`**${rule.id}** (${rule.category})`);
      lines.push(`  ${rule.rule}`);
      if (rule.never) lines.push(`  *Never:* ${rule.never}`);
      lines.push('');
    }
  }

  if (section === 'all' || section === 'workflow') {
    const workflow = data.workflow_guidance as Record<string, unknown> | undefined;
    if (workflow) {
      lines.push('### Recommended Workflow', '');
      const chain = workflow.recommended_tool_chain as string[] | undefined;
      if (chain) {
        for (const step of chain) {
          lines.push(step);
        }
        lines.push('');
      }
      if (workflow.aggregation_first) {
        lines.push(`**Aggregation First:** ${workflow.aggregation_first}`, '');
      }
    }
  }

  if (section === 'all') {
    const thresholds = data.significance_thresholds as Record<string, unknown> | undefined;
    if (thresholds) {
      lines.push('### Significance Thresholds', '');
      lines.push(`- Variance <= ${thresholds.variance_minor_percent}% = ON TARGET`);
      lines.push(`- Variance > ${thresholds.variance_significant_percent}% = SIGNIFICANT`);
      lines.push(`- Variance > ${thresholds.variance_critical_percent}% = CRITICAL`);
      lines.push(`- Scrap rate > ${thresholds.scrap_rate_warning_percent}% = WARNING`);
      lines.push(`- Scrap rate > ${thresholds.scrap_rate_critical_percent}% = CRITICAL`);
      lines.push('');
    }
  }

  lines.push(`*Detail level: ${detailLevel}*`);
  return lines.join('\n');
}

function formatOutputFormatMarkdown(
  data: Record<string, unknown>,
  section: string
): string {
  const lines: string[] = ['## Output Format Specification', ''];

  // Simply pretty-print the relevant section as structured text
  const content = JSON.stringify(data, null, 2);
  lines.push('```json', content, '```');

  return lines.join('\n');
}
