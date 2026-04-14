/**
 * BOM Explosion Service
 *
 * Recursively traverses multi-level Bills of Materials to calculate
 * total standard cost from raw materials up. Handles phantom BOMs,
 * circular detection, and caches results.
 */

import type { OdooClient } from './odoo-client.js';
import type { MrpBom, MrpBomLine, ProductProduct, MrpRoutingWorkcenter, MrpWorkcenter, BomNode, BomOperation, BomExplosionResult } from '../types.js';
import { cache, CACHE_TTL, CACHE_KEYS } from '../utils/cache.js';
import { MFG_FIELDS } from '../constants.js';

const MAX_BOM_DEPTH = 10; // Safety limit for recursion

/**
 * Find the primary BOM for a product.
 * Searches mrp.bom by product_tmpl_id.
 */
export async function getProductBom(
  client: OdooClient,
  productId: number
): Promise<MrpBom | null> {
  // First get the product to find its template
  const products = await client.read<ProductProduct>(
    'product.product',
    [productId],
    ['product_tmpl_id']
  );

  if (!products.length || !products[0].product_tmpl_id) return null;

  const tmplId = (products[0].product_tmpl_id as [number, string])[0];

  // Search for active BOM for this template
  const boms = await client.searchRead<MrpBom>(
    'mrp.bom',
    [['product_tmpl_id', '=', tmplId], ['active', '=', true]],
    MFG_FIELDS.BOM_DETAIL as unknown as string[],
    { limit: 1, order: 'sequence asc, id asc' }
  );

  return boms.length > 0 ? boms[0] : null;
}

/**
 * Convenience: Resolve product to BOM then explode.
 */
export async function getBomTree(
  client: OdooClient,
  productId: number,
  quantity: number = 1
): Promise<BomExplosionResult> {
  const bom = await getProductBom(client, productId);
  if (!bom) {
    throw new Error(`No BOM found for product ID ${productId}`);
  }
  return explodeBom(client, bom.id, quantity);
}

/**
 * Recursively explode a BOM into its full component tree with costs.
 *
 * Algorithm:
 * 1. Check cache and circular detection
 * 2. Fetch BOM header, lines, and operations
 * 3. For each line: check for child BOM → recurse or leaf
 * 4. Compute material + labor costs
 * 5. Cache and return
 */
export async function explodeBom(
  client: OdooClient,
  bomId: number,
  quantity: number = 1,
  visitedBomIds: Set<number> = new Set(),
  depth: number = 0
): Promise<BomExplosionResult> {
  const warnings: string[] = [];

  // 1. Circular detection
  if (visitedBomIds.has(bomId)) {
    warnings.push(`Circular BOM detected at bom_id=${bomId}. Stopping recursion.`);
    return createEmptyResult(bomId, quantity, warnings, depth);
  }

  if (depth > MAX_BOM_DEPTH) {
    warnings.push(`Maximum BOM depth (${MAX_BOM_DEPTH}) reached. Stopping recursion.`);
    return createEmptyResult(bomId, quantity, warnings, depth);
  }

  // 2. Cache check
  const cacheKey = CACHE_KEYS.bomExplosion(bomId, quantity);
  const cached = await cache.get<BomExplosionResult>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  // Mark as visited (copy set for this branch)
  const visited = new Set(visitedBomIds);
  visited.add(bomId);

  // 3. Fetch BOM header
  const boms = await client.read<MrpBom>('mrp.bom', [bomId], MFG_FIELDS.BOM_DETAIL as unknown as string[]);
  if (!boms.length) {
    throw new Error(`BOM ID ${bomId} not found`);
  }
  const bom = boms[0];
  const bomQty = bom.product_qty || 1;
  const bomQtyRatio = quantity / bomQty;

  // Get BOM product info
  const bomProductId = bom.product_id
    ? (bom.product_id as [number, string])[0]
    : null;
  const bomProductName = bom.product_id
    ? (bom.product_id as [number, string])[1]
    : (bom.product_tmpl_id as [number, string])?.[1] || 'Unknown Product';

  // 4. Fetch BOM lines (components)
  const lines = await client.searchRead<MrpBomLine>(
    'mrp.bom.line',
    [['bom_id', '=', bomId]],
    MFG_FIELDS.BOM_LINE as unknown as string[],
    { order: 'sequence asc', limit: 200 }
  );

  // 5. Fetch operations and work center costs
  const operations: BomOperation[] = [];
  if (bom.operation_ids && (bom.operation_ids as number[]).length > 0) {
    const ops = await client.read<MrpRoutingWorkcenter>(
      'mrp.routing.workcenter',
      bom.operation_ids as number[],
      MFG_FIELDS.ROUTING_OPERATION as unknown as string[]
    );

    for (const op of ops) {
      const wcId = op.workcenter_id ? (op.workcenter_id as [number, string])[0] : null;
      const wcName = op.workcenter_id ? (op.workcenter_id as [number, string])[1] : 'Unknown WC';

      let costsHour = 0;
      if (wcId) {
        const wcs = await client.read<MrpWorkcenter>(
          'mrp.workcenter', [wcId],
          ['costs_hour', 'labour_cost_per_hour', 'wc_cost_per_hour']
        );
        if (wcs.length) {
          costsHour = (wcs[0].costs_hour || 0);
        }
      }

      const durationMinutes = op.time_cycle_manual || 0;
      const operationCost = (durationMinutes / 60) * costsHour * bomQtyRatio;

      operations.push({
        operation_id: op.id,
        name: op.name,
        workcenter_id: wcId || 0,
        workcenter_name: wcName,
        duration_expected: durationMinutes * bomQtyRatio,
        costs_hour: costsHour,
        operation_cost: operationCost,
      });
    }
  }

  // 6. Build child nodes
  const children: BomNode[] = [];

  // Batch-fetch all component product info
  const productIds = lines
    .map(l => l.product_id ? (l.product_id as [number, string])[0] : null)
    .filter((id): id is number => id !== null);

  const productsMap = new Map<number, ProductProduct>();
  if (productIds.length > 0) {
    const products = await client.read<ProductProduct>(
      'product.product',
      productIds,
      MFG_FIELDS.PRODUCT_COST as unknown as string[]
    );
    for (const p of products) {
      productsMap.set(p.id, p);
    }
  }

  for (const line of lines) {
    const lineProductId = line.product_id ? (line.product_id as [number, string])[0] : null;
    const lineProductName = line.product_id ? (line.product_id as [number, string])[1] : 'Unknown';

    if (!lineProductId) continue;

    const scaledQty = (line.product_qty || 0) * bomQtyRatio;
    const product = productsMap.get(lineProductId);
    const standardPrice = product?.standard_price || product?.standard_cost_manual || 0;
    const productType = (product?.type || 'consu') as 'consu' | 'product' | 'service';
    const productCode = product?.default_code || undefined;
    const uom = line.product_uom_id ? (line.product_uom_id as [number, string])[1] : 'Units';

    // Check for child BOM
    let childBomId: number | null = null;

    // First check explicit child_bom_id on BOM line
    if (line.child_bom_id && (line.child_bom_id as [number, string])[0]) {
      childBomId = (line.child_bom_id as [number, string])[0];
    }

    // If no explicit child BOM, search by product template
    if (!childBomId && product?.product_tmpl_id) {
      const tmplId = (product.product_tmpl_id as [number, string])[0];
      const childBoms = await client.searchRead<MrpBom>(
        'mrp.bom',
        [['product_tmpl_id', '=', tmplId], ['active', '=', true]],
        ['id', 'type'],
        { limit: 1, order: 'sequence asc' }
      );
      if (childBoms.length > 0) {
        childBomId = childBoms[0].id;
      }
    }

    // Decide: recurse or leaf
    if (childBomId) {
      // Check if we should recurse (phantom always, normal only if manufactured)
      const childBoms = await client.read<MrpBom>('mrp.bom', [childBomId], ['type']);
      const childBomType = childBoms[0]?.type || 'normal';
      const shouldRecurse = childBomType === 'phantom' || productType === 'product';

      if (shouldRecurse) {
        try {
          const childResult = await explodeBom(client, childBomId, scaledQty, visited, depth + 1);
          warnings.push(...childResult.warnings);

          const childNode: BomNode = {
            ...childResult.root,
            product_id: lineProductId,
            product_name: lineProductName,
            product_code: productCode,
            product_type: productType,
            bom_id: childBomId,
            bom_type: childBomType as 'normal' | 'phantom' | 'subcontract',
            quantity: scaledQty,
            uom,
            is_leaf: false,
            depth: depth + 1,
          };
          children.push(childNode);
          continue;
        } catch (error) {
          warnings.push(`Failed to explode child BOM ${childBomId}: ${error instanceof Error ? error.message : String(error)}`);
          // Fall through to leaf node
        }
      }
    }

    // Leaf node
    if (standardPrice === 0) {
      warnings.push(`Zero standard_price on "${lineProductName}" (ID: ${lineProductId})`);
    }

    children.push({
      product_id: lineProductId,
      product_name: lineProductName,
      product_code: productCode,
      product_type: productType,
      bom_id: null,
      bom_type: null,
      quantity: scaledQty,
      uom,
      standard_price: standardPrice,
      line_cost: scaledQty * standardPrice,
      is_leaf: true,
      depth: depth + 1,
      children: [],
      operations: [],
    });
  }

  // 7. Compute totals
  const totalMaterialCost = sumLeafCosts(children);
  const totalLaborCost = operations.reduce((sum, op) => sum + op.operation_cost, 0);
  const totalCost = totalMaterialCost + totalLaborCost;
  const maxDepth = getMaxDepth(children);

  const root: BomNode = {
    product_id: bomProductId || 0,
    product_name: bomProductName,
    product_type: 'product',
    bom_id: bomId,
    bom_type: (bom.type || 'normal') as 'normal' | 'phantom' | 'subcontract',
    quantity,
    uom: bom.product_uom_id ? (bom.product_uom_id as [number, string])[1] : 'Units',
    standard_price: quantity > 0 ? totalCost / quantity : 0,
    line_cost: totalCost,
    is_leaf: false,
    depth,
    children,
    operations,
  };

  const result: BomExplosionResult = {
    root,
    total_material_cost: totalMaterialCost,
    total_labor_cost: totalLaborCost,
    total_cost: totalCost,
    per_unit_cost: quantity > 0 ? totalCost / quantity : 0,
    quantity,
    depth_reached: maxDepth,
    warnings,
    cached: false,
  };

  // 8. Cache result
  await cache.set(cacheKey, result, CACHE_TTL.BOM_EXPLOSION);

  return result;
}

// =============================================================================
// HELPERS
// =============================================================================

function sumLeafCosts(nodes: BomNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.is_leaf) {
      total += node.line_cost;
    } else {
      total += sumLeafCosts(node.children);
    }
  }
  return total;
}

function getMaxDepth(nodes: BomNode[]): number {
  let maxDepth = 0;
  for (const node of nodes) {
    maxDepth = Math.max(maxDepth, node.depth);
    if (node.children.length > 0) {
      maxDepth = Math.max(maxDepth, getMaxDepth(node.children));
    }
  }
  return maxDepth;
}

function createEmptyResult(
  bomId: number,
  quantity: number,
  warnings: string[],
  depth: number
): BomExplosionResult {
  return {
    root: {
      product_id: 0,
      product_name: 'Unknown',
      product_type: 'product',
      bom_id: bomId,
      bom_type: 'normal',
      quantity,
      uom: 'Units',
      standard_price: 0,
      line_cost: 0,
      is_leaf: false,
      depth,
      children: [],
      operations: [],
    },
    total_material_cost: 0,
    total_labor_cost: 0,
    total_cost: 0,
    per_unit_cost: 0,
    quantity,
    depth_reached: depth,
    warnings,
    cached: false,
  };
}
