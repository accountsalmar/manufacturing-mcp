/**
 * BOM Explosion Service
 *
 * Recursively traverses multi-level Bills of Materials to calculate
 * total standard cost from raw materials up. Handles phantom BOMs,
 * circular detection (both BOM ID and product template ID),
 * and caches results.
 */

import type { OdooClient } from './odoo-client.js';
import type { MrpBom, MrpBomLine, ProductProduct, MrpRoutingWorkcenter, MrpWorkcenter, BomNode, BomOperation, BomExplosionResult } from '../types.js';
import { cache, CACHE_TTL, CACHE_KEYS } from '../utils/cache.js';
import { MFG_FIELDS } from '../constants.js';

const MAX_BOM_DEPTH = 10;

// Module-level flag: once standard_price is access-denied, don't retry
let useStandardPriceFallback = false;

/**
 * Tracks visited BOMs and product templates to prevent circular references.
 * A circular reference can happen when:
 * - BOM A contains component B, and BOM B contains component A (BOM ID cycle)
 * - Product template X's BOM contains a component whose template IS X (template cycle)
 */
interface VisitedTracker {
  bomIds: Set<number>;
  productTmplIds: Set<number>;
}

function createTracker(existing?: VisitedTracker): VisitedTracker {
  return {
    bomIds: new Set(existing?.bomIds),
    productTmplIds: new Set(existing?.productTmplIds),
  };
}

/**
 * Find the primary BOM for a product.
 */
export async function getProductBom(
  client: OdooClient,
  productId: number
): Promise<MrpBom | null> {
  const products = await client.read<ProductProduct>(
    'product.product', [productId], ['product_tmpl_id']
  );
  if (!products.length || !products[0].product_tmpl_id) return null;

  const tmplId = (products[0].product_tmpl_id as [number, string])[0];

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
 */
export async function explodeBom(
  client: OdooClient,
  bomId: number,
  quantity: number = 1,
  visited?: VisitedTracker,
  depth: number = 0
): Promise<BomExplosionResult> {
  const warnings: string[] = [];
  const tracker = createTracker(visited);

  // 1. Circular detection — BOM ID
  if (tracker.bomIds.has(bomId)) {
    warnings.push(`Circular BOM detected at bom_id=${bomId}. Stopping recursion — using $0 cost for this branch.`);
    console.error(`[BOM] CIRCULAR REFERENCE: bom_id=${bomId} already visited. Path: [${Array.from(tracker.bomIds).join(' → ')} → ${bomId}]`);
    return createEmptyResult(bomId, quantity, warnings, depth);
  }

  if (depth > MAX_BOM_DEPTH) {
    warnings.push(`Maximum BOM depth (${MAX_BOM_DEPTH}) reached at bom_id=${bomId}. Stopping recursion.`);
    console.error(`[BOM] MAX DEPTH: bom_id=${bomId} at depth=${depth}`);
    return createEmptyResult(bomId, quantity, warnings, depth);
  }

  // 2. Cache check
  const cacheKey = CACHE_KEYS.bomExplosion(bomId, quantity);
  const cached = await cache.get<BomExplosionResult>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  tracker.bomIds.add(bomId);

  // 3. Fetch BOM header
  const boms = await client.read<MrpBom>('mrp.bom', [bomId], MFG_FIELDS.BOM_DETAIL as unknown as string[]);
  if (!boms.length) {
    throw new Error(`BOM ID ${bomId} not found`);
  }
  const bom = boms[0];
  const bomQty = bom.product_qty || 1;
  const bomQtyRatio = quantity / bomQty;

  // Track the BOM's product template to detect product-level cycles
  const bomTmplId = bom.product_tmpl_id ? (bom.product_tmpl_id as [number, string])[0] : null;
  if (bomTmplId) {
    tracker.productTmplIds.add(bomTmplId);
  }

  const bomProductId = bom.product_id
    ? (bom.product_id as [number, string])[0]
    : null;
  const bomProductName = bom.product_id
    ? (bom.product_id as [number, string])[1]
    : (bom.product_tmpl_id as [number, string])?.[1] || 'Unknown Product';

  // 4. Fetch BOM lines
  const lines = await client.searchRead<MrpBomLine>(
    'mrp.bom.line',
    [['bom_id', '=', bomId]],
    MFG_FIELDS.BOM_LINE as unknown as string[],
    { order: 'sequence asc', limit: 200 }
  );

  // 5. Fetch operations
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
        if (wcs.length) costsHour = wcs[0].costs_hour || 0;
      }

      const durationMinutes = op.time_cycle_manual || 0;
      operations.push({
        operation_id: op.id,
        name: op.name,
        workcenter_id: wcId || 0,
        workcenter_name: wcName,
        duration_expected: durationMinutes * bomQtyRatio,
        costs_hour: costsHour,
        operation_cost: (durationMinutes / 60) * costsHour * bomQtyRatio,
      });
    }
  }

  // 6. Batch-fetch all component product info
  const children: BomNode[] = [];
  const productIds = lines
    .map(l => l.product_id ? (l.product_id as [number, string])[0] : null)
    .filter((id): id is number => id !== null);

  const productsMap = new Map<number, ProductProduct>();
  if (productIds.length > 0) {
    const products = await fetchProductsSafe(client, productIds, warnings);
    for (const p of products) {
      productsMap.set(p.id, p);
    }
  }

  // 7. Build child nodes
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

    // Check for child BOM — with circular detection on product template
    let childBomId: number | null = null;
    let skipRecursion = false;

    // Check explicit child_bom_id on BOM line
    if (line.child_bom_id && (line.child_bom_id as [number, string])[0]) {
      childBomId = (line.child_bom_id as [number, string])[0];
    }

    // If no explicit child BOM, search by product template
    if (!childBomId && product?.product_tmpl_id) {
      const tmplId = (product.product_tmpl_id as [number, string])[0];

      // CIRCULAR CHECK: if this product template is already in our ancestor chain, skip
      if (tracker.productTmplIds.has(tmplId)) {
        warnings.push(`Circular product reference detected: "${lineProductName}" (tmpl_id=${tmplId}) already in ancestor chain. Using standard_price instead of recursing.`);
        console.error(`[BOM] CIRCULAR PRODUCT: tmpl_id=${tmplId} "${lineProductName}" at depth=${depth + 1}`);
        skipRecursion = true;
      } else {
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
    }

    // Also check BOM ID circular
    if (childBomId && tracker.bomIds.has(childBomId)) {
      warnings.push(`Circular BOM reference: bom_id=${childBomId} for "${lineProductName}" already visited. Using standard_price.`);
      console.error(`[BOM] CIRCULAR BOM: bom_id=${childBomId} "${lineProductName}" at depth=${depth + 1}`);
      skipRecursion = true;
      childBomId = null;
    }

    // Decide: recurse or leaf
    if (childBomId && !skipRecursion) {
      const childBomData = await client.read<MrpBom>('mrp.bom', [childBomId], ['type']);
      const childBomType = childBomData[0]?.type || 'normal';
      const shouldRecurse = childBomType === 'phantom' || productType === 'product';

      if (shouldRecurse) {
        try {
          const childResult = await explodeBom(client, childBomId, scaledQty, tracker, depth + 1);
          warnings.push(...childResult.warnings);

          children.push({
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
          });
          continue;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[BOM] Child explosion failed for bom_id=${childBomId}: ${errMsg}`);
          warnings.push(`Failed to explode child BOM ${childBomId}: ${errMsg}. Using standard_price as leaf.`);
        }
      }
    }

    // Leaf node
    if (standardPrice === 0) {
      warnings.push(`Zero cost on "${lineProductName}" (ID: ${lineProductId})`);
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

  // 8. Compute totals
  const totalMaterialCost = sumLeafCosts(children);
  const totalLaborCost = operations.reduce((sum, op) => sum + op.operation_cost, 0);
  const totalCost = totalMaterialCost + totalLaborCost;

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
    depth_reached: getMaxDepth(children),
    warnings,
    cached: false,
  };

  // 9. Cache result
  await cache.set(cacheKey, result, CACHE_TTL.BOM_EXPLOSION);

  return result;
}

// =============================================================================
// PRODUCT FETCH WITH standard_price FALLBACK
// =============================================================================

async function fetchProductsSafe(
  client: OdooClient,
  productIds: number[],
  warnings: string[]
): Promise<ProductProduct[]> {
  if (useStandardPriceFallback) {
    return client.read<ProductProduct>(
      'product.product', productIds,
      MFG_FIELDS.PRODUCT_COST as unknown as string[]
    );
  }

  try {
    return await client.read<ProductProduct>(
      'product.product', productIds,
      MFG_FIELDS.PRODUCT_COST_WITH_STD_PRICE as unknown as string[]
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('not have enough rights') || errMsg.includes('standard_price')) {
      useStandardPriceFallback = true;
      warnings.push('standard_price access denied — using standard_cost_manual as fallback.');
      return client.read<ProductProduct>(
        'product.product', productIds,
        MFG_FIELDS.PRODUCT_COST as unknown as string[]
      );
    }
    throw error;
  }
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
      product_name: 'Circular Reference (stopped)',
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
