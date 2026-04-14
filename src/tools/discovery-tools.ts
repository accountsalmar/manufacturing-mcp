/**
 * Discovery & Lookup Tools (5 tools)
 *
 * Search and retrieve manufacturing data from Odoo.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useClient } from '../services/odoo-pool.js';
import { explodeBom, getProductBom, getBomTree } from '../services/bom-service.js';
import type { MrpProduction, MrpWorkcenter, ProductProduct, MrpWorkorder, StockMove, StockScrap, BomNode } from '../types.js';
import { MFG_FIELDS, CONTEXT_LIMITS, ResponseFormat, resolveFields } from '../constants.js';
import {
  SearchMOsSchema, GetMODetailSchema, GetBomStructureSchema,
  SearchProductsSchema, GetWorkCenterInfoSchema,
  type SearchMOsInput, type GetMODetailInput, type GetBomStructureInput,
  type SearchProductsInput, type GetWorkCenterInfoInput,
} from '../schemas/index.js';
import {
  formatCurrency, formatDate, formatDuration, formatMOState,
  getRelationName, formatPaginationFooter, formatPercent,
} from '../services/formatters.js';

export function registerDiscoveryTools(server: McpServer): void {

  // ==========================================================================
  // Tool 1: search_manufacturing_orders
  // ==========================================================================
  server.tool(
    'search_manufacturing_orders',
    'Search and filter Odoo Manufacturing Orders with pagination. Returns MO list with status, costs, and dates. Use state filter for done/progress/draft. Start here to find MOs for analysis.',
    SearchMOsSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = SearchMOsSchema.parse(args) as SearchMOsInput;

      try {
        return await useClient(async (client) => {
          const domain: unknown[] = [];

          if (input.query) {
            domain.push('|',
              ['name', 'ilike', input.query],
              ['origin', 'ilike', input.query]
            );
          }
          if (input.state) domain.push(['state', '=', input.state]);
          if (input.product_id) domain.push(['product_id', '=', input.product_id]);
          if (input.partner_id) domain.push(['partner_id', '=', input.partner_id]);
          if (input.date_from) domain.push(['date_start', '>=', input.date_from]);
          if (input.date_to) domain.push(['date_start', '<=', input.date_to]);

          const fields = resolveFields(input.fields, 'mo', 'basic');
          const [records, total] = await Promise.all([
            client.searchRead<MrpProduction>('mrp.production', domain, fields, {
              offset: input.offset,
              limit: input.limit,
              order: 'date_start desc, id desc',
            }),
            client.searchCount('mrp.production', domain),
          ]);

          const hasMore = input.offset + records.length < total;

          if (input.response_format === ResponseFormat.JSON) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ total, count: records.length, offset: input.offset, limit: input.limit, has_more: hasMore, items: records }, null, 2) }],
            };
          }

          // Markdown format
          let md = `## Manufacturing Orders (${records.length} of ${total})\n\n`;

          if (records.length === 0) {
            md += '_No manufacturing orders found matching your criteria._\n';
          } else {
            for (const mo of records) {
              md += `- **${mo.name}** (ID: ${mo.id})\n`;
              md += `  Product: ${getRelationName(mo.product_id)} | Qty: ${mo.product_qty || '-'}\n`;
              md += `  State: ${formatMOState(mo.state)} | Start: ${formatDate(mo.date_start)}\n`;
              const stdCost = typeof mo.std_cost === 'number' ? mo.std_cost : 0;
              const moCost = typeof mo.mo_cost === 'number' ? mo.mo_cost : 0;
              md += `  Std Cost: ${formatCurrency(stdCost)} | Actual: ${formatCurrency(moCost)}`;
              if (mo.state === 'done' && stdCost === 0 && moCost === 0) {
                md += ` ⚠ No cost data`;
              }
              md += '\n';
              if (mo.partner_id) md += `  Customer: ${getRelationName(mo.partner_id)}\n`;
              if (mo.analytic_account_id) md += `  Job: ${getRelationName(mo.analytic_account_id)}\n`;
              md += '\n';
            }
          }

          md += formatPaginationFooter(records.length, total, input.offset, hasMore, hasMore ? input.offset + input.limit : undefined);
          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error searching MOs: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 2: get_mo_detail
  // ==========================================================================
  server.tool(
    'get_mo_detail',
    'Get full details of a specific Manufacturing Order including linked work orders, consumed materials (stock moves), and scrap records. Provides complete MO context for cost analysis.',
    GetMODetailSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetMODetailSchema.parse(args) as GetMODetailInput;

      try {
        return await useClient(async (client) => {
          // Fetch MO
          const mos = await client.read<MrpProduction>(
            'mrp.production', [input.mo_id],
            MFG_FIELDS.MO_DETAIL as unknown as string[]
          );
          if (!mos.length) {
            return { content: [{ type: 'text', text: `Manufacturing Order ID ${input.mo_id} not found.` }], isError: true };
          }
          const mo = mos[0];

          // Fetch linked records in parallel
          const [workOrders, rawMoves, scrapRecords] = await Promise.all([
            client.searchRead<MrpWorkorder>('mrp.workorder',
              [['production_id', '=', mo.id]],
              MFG_FIELDS.WORKORDER_LIST as unknown as string[],
              { order: 'id asc', limit: 50 }
            ),
            client.searchRead<StockMove>('stock.move',
              [['raw_material_production_id', '=', mo.id], ['state', '=', 'done']],
              MFG_FIELDS.STOCK_MOVE_MO as unknown as string[],
              { order: 'id asc', limit: 200 }
            ),
            client.searchRead<StockScrap>('stock.scrap',
              [['production_id', '=', mo.id]],
              MFG_FIELDS.STOCK_SCRAP as unknown as string[],
              { order: 'id asc', limit: 50 }
            ),
          ]);

          if (input.response_format === ResponseFormat.JSON) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ mo, work_orders: workOrders, raw_materials: rawMoves, scrap: scrapRecords }, null, 2) }],
            };
          }

          // Markdown format
          let md = `## ${mo.name} — Manufacturing Order Detail\n\n`;

          // Header info
          md += `**Product:** ${getRelationName(mo.product_id)} | **Qty:** ${mo.product_qty}\n`;
          md += `**State:** ${formatMOState(mo.state)} | **BOM:** ${getRelationName(mo.bom_id)}\n`;
          md += `**Start:** ${formatDate(mo.date_start)} | **End:** ${formatDate(mo.date_finished)}\n`;

          if (mo.partner_id) md += `**Customer:** ${getRelationName(mo.partner_id)}\n`;
          if (mo.analytic_account_id) md += `**Job:** ${getRelationName(mo.analytic_account_id)}\n`;

          // Cost summary
          if (mo.std_cost !== undefined || mo.mo_cost !== undefined) {
            md += `\n### Cost Summary\n`;
            md += `| Metric | Value |\n|--------|-------|\n`;
            md += `| Standard Cost | ${formatCurrency(mo.std_cost)} |\n`;
            md += `| Actual Cost | ${formatCurrency(mo.mo_cost)} |\n`;
            if (mo.m_cost_diff !== undefined) md += `| Material Diff | ${formatCurrency(mo.m_cost_diff)} |\n`;
            if (mo.l_cost_diff !== undefined) md += `| Labor Diff | ${formatCurrency(mo.l_cost_diff)} |\n`;
            if (mo.job_revenue !== undefined) md += `| Revenue | ${formatCurrency(mo.job_revenue)} |\n`;
          }

          // Work orders
          if (workOrders.length > 0) {
            md += `\n### Work Orders (${workOrders.length})\n\n`;
            md += `| WO | Work Center | Expected | Actual | Status |\n`;
            md += `|----|------------|----------|--------|--------|\n`;
            for (const wo of workOrders) {
              md += `| ${wo.name || wo.id} | ${getRelationName(wo.workcenter_id)} | ${formatDuration(wo.duration_expected)} | ${formatDuration(wo.duration)} | ${wo.state || '-'} |\n`;
            }
          }

          // Raw materials consumed
          if (rawMoves.length > 0) {
            md += `\n### Materials Consumed (${rawMoves.length})\n\n`;
            md += `| Product | Qty | Unit Cost | Total |\n`;
            md += `|---------|-----|-----------|-------|\n`;
            for (const move of rawMoves) {
              const qty = move.quantity || move.product_uom_qty || 0;
              const unitCost = move.price_unit || 0;
              md += `| ${getRelationName(move.product_id)} | ${qty} | ${formatCurrency(unitCost)} | ${formatCurrency(qty * unitCost)} |\n`;
            }
          }

          // Scrap
          if (scrapRecords.length > 0) {
            md += `\n### Scrap Records (${scrapRecords.length})\n\n`;
            for (const scrap of scrapRecords) {
              md += `- ${getRelationName(scrap.product_id)}: ${scrap.scrap_qty} units (${scrap.state})\n`;
            }
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error fetching MO detail: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 3: get_bom_structure
  // ==========================================================================
  server.tool(
    'get_bom_structure',
    'Smart BOM explosion: recursively traverse multi-level BOMs to raw materials with cost at each level. Handles phantom/kit BOMs by auto-exploding. Caches results for 10 minutes. Provide bom_id OR product_id.',
    GetBomStructureSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetBomStructureSchema.parse(args) as GetBomStructureInput;

      try {
        return await useClient(async (client) => {
          let result;
          try {
            if (input.bom_id) {
              result = await explodeBom(client, input.bom_id, input.quantity);
            } else if (input.product_id) {
              result = await getBomTree(client, input.product_id, input.quantity);
            } else {
              return { content: [{ type: 'text', text: 'Either bom_id or product_id must be provided.' }], isError: true };
            }
          } catch (bomError) {
            const errMsg = bomError instanceof Error ? bomError.message : String(bomError);
            const stack = bomError instanceof Error ? bomError.stack : '';
            console.error(`[BOM Explosion Error] ${errMsg}\n${stack}`);
            return { content: [{ type: 'text', text: `BOM explosion error: ${errMsg}` }], isError: true };
          }

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // Markdown BOM tree
          let md = `## BOM Cost Tree: ${result.root.product_name} (Qty: ${result.quantity})\n\n`;

          if (result.cached) md += `*Cached result*\n\n`;

          // Render tree
          md += renderBomTree(result.root.children, '');

          // Operations/Labor
          if (result.root.operations.length > 0) {
            md += `└── **Labor & Overhead**\n`;
            for (const op of result.root.operations) {
              md += `    - ${op.name} @ ${op.workcenter_name}: ${formatDuration(op.duration_expected)} × ${formatCurrency(op.costs_hour)}/h = ${formatCurrency(op.operation_cost)}\n`;
            }
          }

          // Totals
          md += `\n---\n`;
          md += `**Materials:** ${formatCurrency(result.total_material_cost)}`;
          md += ` | **Labor:** ${formatCurrency(result.total_labor_cost)}`;
          md += ` | **Total:** ${formatCurrency(result.total_cost)}`;
          md += ` | **Per Unit:** ${formatCurrency(result.per_unit_cost)}\n`;

          if (result.warnings.length > 0) {
            md += `\n### Warnings\n`;
            for (const w of result.warnings) {
              md += `- ${w}\n`;
            }
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error exploding BOM: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 4: search_products
  // ==========================================================================
  server.tool(
    'search_products',
    'Search for products by name, internal reference, category, or type (manufactured/purchased/service). Returns product list with standard cost. Use to find product IDs for other tools.',
    SearchProductsSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = SearchProductsSchema.parse(args) as SearchProductsInput;

      try {
        return await useClient(async (client) => {
          const domain: unknown[] = [];
          if (input.query) {
            domain.push('|',
              ['name', 'ilike', input.query],
              ['default_code', 'ilike', input.query]
            );
          }
          if (input.category_id) domain.push(['categ_id', '=', input.category_id]);
          if (input.product_type) domain.push(['type', '=', input.product_type]);

          // Try with standard_price first, fall back if access denied
          let fields = MFG_FIELDS.PRODUCT_COST_WITH_STD_PRICE as unknown as string[];
          let records: ProductProduct[];
          let total: number;
          try {
            [records, total] = await Promise.all([
              client.searchRead<ProductProduct>('product.product', domain, fields, {
                offset: input.offset,
                limit: input.limit,
                order: 'name asc',
              }),
              client.searchCount('product.product', domain),
            ]);
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            if (errMsg.includes('not have enough rights') || errMsg.includes('standard_price')) {
              fields = MFG_FIELDS.PRODUCT_COST as unknown as string[];
              [records, total] = await Promise.all([
                client.searchRead<ProductProduct>('product.product', domain, fields, {
                  offset: input.offset,
                  limit: input.limit,
                  order: 'name asc',
                }),
                client.searchCount('product.product', domain),
              ]);
            } else {
              throw error;
            }
          }

          const hasMore = input.offset + records.length < total;

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify({ total, count: records.length, offset: input.offset, items: records }, null, 2) }] };
          }

          let md = `## Products (${records.length} of ${total})\n\n`;
          if (records.length === 0) {
            md += '_No products found._\n';
          } else {
            md += `| ID | Ref | Name | Type | Std Cost |\n`;
            md += `|----|-----|------|------|----------|\n`;
            for (const p of records) {
              md += `| ${p.id} | ${p.default_code || '-'} | ${p.name} | ${p.type || '-'} | ${formatCurrency(p.standard_price || p.standard_cost_manual)} |\n`;
            }
          }

          md += formatPaginationFooter(records.length, total, input.offset, hasMore, hasMore ? input.offset + input.limit : undefined);
          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error searching products: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ==========================================================================
  // Tool 5: get_work_center_info
  // ==========================================================================
  server.tool(
    'get_work_center_info',
    'Get work center details: hourly cost (total, labour, overhead), capacity, efficiency, setup/cleanup times. Provide workcenter_id or name to search.',
    GetWorkCenterInfoSchema.shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const input = GetWorkCenterInfoSchema.parse(args) as GetWorkCenterInfoInput;

      try {
        return await useClient(async (client) => {
          let workcenters: MrpWorkcenter[];

          if (input.workcenter_id) {
            workcenters = await client.read<MrpWorkcenter>(
              'mrp.workcenter', [input.workcenter_id],
              MFG_FIELDS.WORKCENTER_LIST as unknown as string[]
            );
          } else if (input.name) {
            workcenters = await client.searchRead<MrpWorkcenter>(
              'mrp.workcenter',
              [['name', 'ilike', input.name], ['active', '=', true]],
              MFG_FIELDS.WORKCENTER_LIST as unknown as string[],
              { limit: 10 }
            );
          } else {
            // Return all work centers
            workcenters = await client.getWorkcentersCached();
          }

          if (workcenters.length === 0) {
            return { content: [{ type: 'text', text: 'No work centers found.' }] };
          }

          if (input.response_format === ResponseFormat.JSON) {
            return { content: [{ type: 'text', text: JSON.stringify(workcenters, null, 2) }] };
          }

          let md = `## Work Centers (${workcenters.length})\n\n`;
          for (const wc of workcenters) {
            md += `### ${wc.name} (ID: ${wc.id})\n`;
            md += `| Metric | Value |\n|--------|-------|\n`;
            md += `| Total Cost/Hour | ${formatCurrency(wc.costs_hour)} |\n`;
            if (wc.labour_cost_per_hour) md += `| Labour Cost/Hour | ${formatCurrency(wc.labour_cost_per_hour)} |\n`;
            if (wc.wc_cost_per_hour) md += `| WC Overhead/Hour | ${formatCurrency(wc.wc_cost_per_hour)} |\n`;
            md += `| Capacity | ${wc.default_capacity || '-'} |\n`;
            if (wc.time_efficiency) md += `| Efficiency | ${formatPercent(wc.time_efficiency)} |\n`;
            if (wc.time_start) md += `| Setup Time | ${formatDuration(wc.time_start)} |\n`;
            if (wc.time_stop) md += `| Cleanup Time | ${formatDuration(wc.time_stop)} |\n`;
            if (wc.center_type) md += `| Type | ${wc.center_type} |\n`;
            md += '\n';
          }

          return { content: [{ type: 'text', text: md }] };
        });
      } catch (error) {
        return { content: [{ type: 'text', text: `Error fetching work center: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}

// =============================================================================
// BOM TREE RENDERER
// =============================================================================

function renderBomTree(nodes: BomNode[], prefix: string): string {
  let md = '';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    const qtyStr = node.quantity % 1 === 0 ? node.quantity.toString() : node.quantity.toFixed(2);

    if (node.is_leaf) {
      md += `${prefix}${connector}${node.product_name} ×${qtyStr} @ ${formatCurrency(node.standard_price)} = ${formatCurrency(node.line_cost)}\n`;
    } else {
      md += `${prefix}${connector}**${node.product_name}** ×${qtyStr} (Subtotal: ${formatCurrency(node.line_cost)})\n`;
      md += renderBomTree(node.children, childPrefix);

      // Operations at this level
      for (const op of node.operations) {
        md += `${childPrefix}  [${op.name}: ${formatDuration(op.duration_expected)} × ${formatCurrency(op.costs_hour)}/h = ${formatCurrency(op.operation_cost)}]\n`;
      }
    }
  }
  return md;
}
