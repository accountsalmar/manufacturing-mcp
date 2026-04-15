/**
 * Cost Calculator Service
 *
 * Computes standard cost, actual cost, and variance for Manufacturing Orders.
 * Uses BOM service for standard cost.
 * Uses stock.valuation.layer (not stock.move.price_unit) for actual material cost.
 */

import type { OdooClient } from './odoo-client.js';
import { explodeBom, getProductBom } from './bom-service.js';
import type {
  MrpProduction, MrpWorkorder, MrpWorkcenter, StockMove, StockScrap,
  ProductProduct, StockValuationLayer,
  BomExplosionResult, ActualCostResult, ComponentActualCost, WorkOrderActualCost,
  VarianceResult, CostVariance, MaterialVariance, LaborVariance,
} from '../types.js';
import { MFG_FIELDS, VARIANCE_THRESHOLDS } from '../constants.js';

// Module-level flag: once standard_price is access-denied, don't retry
let useStandardPriceFallback = false;

// =============================================================================
// STANDARD COST
// =============================================================================

export async function calculateStandardCost(
  client: OdooClient,
  productId: number,
  quantity: number = 1,
  bomId?: number
): Promise<BomExplosionResult> {
  let resolvedBomId = bomId;
  if (!resolvedBomId) {
    const bom = await getProductBom(client, productId);
    if (!bom) throw new Error(`No BOM found for product ID ${productId}`);
    resolvedBomId = bom.id;
  }

  return explodeBom(client, resolvedBomId, quantity);
}

// =============================================================================
// ACTUAL COST — uses stock.valuation.layer for material costs
// =============================================================================

export async function calculateActualCost(
  client: OdooClient,
  moId: number,
  includeScrap: boolean = true
): Promise<ActualCostResult> {
  const warnings: string[] = [];

  // 1. Fetch MO
  const mos = await client.read<MrpProduction>(
    'mrp.production', [moId],
    MFG_FIELDS.MO_DETAIL as unknown as string[]
  );
  if (!mos.length) throw new Error(`Manufacturing Order ID ${moId} not found`);
  const mo = mos[0];

  const isEstimate = mo.state !== 'done' && mo.state !== 'to_close';
  if (isEstimate) {
    warnings.push(`MO is in '${mo.state}' state — costs are ESTIMATES, not final.`);
  }

  const moQty = mo.product_qty || 1;
  const productName = mo.product_id ? (mo.product_id as [number, string])[1] : 'Unknown';

  // 2. Fetch consumed stock moves (raw materials)
  const rawMoves = await client.searchRead<StockMove>(
    'stock.move',
    [['raw_material_production_id', '=', moId], ['state', '=', 'done']],
    MFG_FIELDS.STOCK_MOVE_MO as unknown as string[],
    { order: 'id asc', limit: 500 }
  );

  // 3. Fetch valuation layers for these moves (the REAL cost data)
  const moveIds = rawMoves.map(m => m.id);
  const valuationMap = new Map<number, { unit_cost: number; value: number; quantity: number }>();

  if (moveIds.length > 0) {
    try {
      const layers = await client.searchRead<StockValuationLayer>(
        'stock.valuation.layer',
        [['stock_move_id', 'in', moveIds]],
        MFG_FIELDS.VALUATION_LAYER as unknown as string[],
        { order: 'id asc', limit: 1000 }
      );

      // Aggregate layers per move (a move can have multiple layers)
      for (const layer of layers) {
        const moveId = layer.stock_move_id ? (layer.stock_move_id as [number, string])[0] : 0;
        if (!moveId) continue;

        const existing = valuationMap.get(moveId);
        if (existing) {
          existing.value += layer.value || 0;
          existing.quantity += layer.quantity || 0;
          existing.unit_cost = existing.quantity !== 0
            ? existing.value / existing.quantity
            : 0;
        } else {
          valuationMap.set(moveId, {
            unit_cost: layer.unit_cost || 0,
            value: layer.value || 0,
            quantity: layer.quantity || 0,
          });
        }
      }

      if (layers.length > 0) {
        console.error(`[Cost] Found ${layers.length} valuation layers for ${moveIds.length} stock moves`);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Cost] Failed to read stock.valuation.layer: ${errMsg}`);
      warnings.push(`Could not read stock.valuation.layer: ${errMsg}. Falling back to stock.move.price_unit.`);
    }
  }

  // 4. Build component costs using valuation layers (primary) or move.price_unit (fallback)
  const componentMap = new Map<number, ComponentActualCost>();
  let totalMaterialCost = 0;

  for (const move of rawMoves) {
    const prodId = move.product_id ? (move.product_id as [number, string])[0] : 0;
    const prodName = move.product_id ? (move.product_id as [number, string])[1] : 'Unknown';
    const qty = move.quantity || move.product_uom_qty || 0;

    // Get cost: prefer valuation layer, fall back to move.price_unit
    const valuation = valuationMap.get(move.id);
    let unitCost: number;
    let lineCost: number;

    if (valuation && valuation.value !== 0) {
      // Use valuation layer (accurate for AVCO/Standard costing)
      unitCost = Math.abs(valuation.unit_cost);
      lineCost = Math.abs(valuation.value);
    } else if (move.price_unit && move.price_unit !== 0) {
      // Fall back to stock.move price_unit
      unitCost = Math.abs(move.price_unit);
      lineCost = qty * unitCost;
    } else {
      // No valuation at all
      unitCost = 0;
      lineCost = 0;
      if (qty > 0) {
        warnings.push(`No valuation for "${prodName}" (move ID: ${move.id}) — cost = $0.`);
      }
    }

    const existing = componentMap.get(prodId);
    if (existing) {
      existing.actual_qty += qty;
      existing.actual_cost += lineCost;
      existing.actual_price = existing.actual_qty > 0 ? existing.actual_cost / existing.actual_qty : 0;
    } else {
      componentMap.set(prodId, {
        product_id: prodId,
        product_name: prodName,
        planned_qty: 0,
        actual_qty: qty,
        standard_price: 0,
        actual_price: unitCost,
        standard_cost: 0,
        actual_cost: lineCost,
        variance: 0,
      });
    }

    totalMaterialCost += lineCost;
  }

  // 5. If valuation layers returned zero for ALL components, try standard_cost_manual as last resort
  if (totalMaterialCost === 0 && rawMoves.length > 0) {
    warnings.push('All valuation layers returned $0. Attempting standard_cost_manual fallback for material costs.');

    const productIds = Array.from(componentMap.keys());
    if (productIds.length > 0) {
      const products = await fetchProductPricesSafe(client, productIds, warnings);
      for (const p of products) {
        const comp = componentMap.get(p.id);
        if (comp) {
          const fallbackPrice = p.standard_price || p.standard_cost_manual || 0;
          if (fallbackPrice > 0) {
            comp.actual_price = fallbackPrice;
            comp.actual_cost = comp.actual_qty * fallbackPrice;
            totalMaterialCost += comp.actual_cost;
          }
        }
      }
      if (totalMaterialCost > 0) {
        warnings.push(`Material cost recovered using standard_cost_manual fallback: $${totalMaterialCost.toFixed(2)}`);
      }
    }
  }

  // 6. Fetch standard prices for variance calculation
  const productIds = Array.from(componentMap.keys());
  if (productIds.length > 0) {
    const products = await fetchProductPricesSafe(client, productIds, warnings);
    for (const p of products) {
      const comp = componentMap.get(p.id);
      if (comp) {
        comp.standard_price = p.standard_price || p.standard_cost_manual || 0;
        comp.standard_cost = comp.planned_qty * comp.standard_price;
        comp.variance = comp.actual_cost - comp.standard_cost;
      }
    }
  }

  const components = Array.from(componentMap.values());

  // 7. Fetch work orders + work center costs
  const workOrders = await client.searchRead<MrpWorkorder>(
    'mrp.workorder',
    [['production_id', '=', moId]],
    MFG_FIELDS.WORKORDER_LIST as unknown as string[],
    { order: 'id asc', limit: 100 }
  );

  const workOrderCosts: WorkOrderActualCost[] = [];
  let totalLaborCost = 0;

  for (const wo of workOrders) {
    const wcId = wo.workcenter_id ? (wo.workcenter_id as [number, string])[0] : 0;
    const wcName = wo.workcenter_id ? (wo.workcenter_id as [number, string])[1] : 'Unknown WC';

    let costsHour = wo.costs_hour || 0;
    if (!costsHour && wcId) {
      const wcs = await client.read<MrpWorkcenter>(
        'mrp.workcenter', [wcId], ['costs_hour']
      );
      if (wcs.length) costsHour = wcs[0].costs_hour || 0;
    }

    const expectedDuration = wo.duration_expected || 0;
    const actualDuration = wo.duration || 0;
    const standardCost = (expectedDuration / 60) * costsHour;
    const actualCost = (actualDuration / 60) * costsHour;

    workOrderCosts.push({
      workorder_id: wo.id,
      workorder_name: wo.name || `WO-${wo.id}`,
      workcenter_id: wcId,
      workcenter_name: wcName,
      expected_duration: expectedDuration,
      actual_duration: actualDuration,
      costs_hour: costsHour,
      standard_cost: standardCost,
      actual_cost: actualCost,
      variance: actualCost - standardCost,
    });

    totalLaborCost += actualCost;
  }

  // 8. Fetch scrap
  let totalScrapCost = 0;
  let totalScrapQty = 0;
  let scrapRecords: StockScrap[] = [];

  if (includeScrap) {
    scrapRecords = await client.searchRead<StockScrap>(
      'stock.scrap',
      [['production_id', '=', moId]],
      MFG_FIELDS.STOCK_SCRAP as unknown as string[],
      { limit: 100 }
    );

    for (const scrap of scrapRecords) {
      const scrapQty = scrap.scrap_qty || 0;
      totalScrapQty += scrapQty;

      const scrapProdId = scrap.product_id ? (scrap.product_id as [number, string])[0] : 0;
      const comp = componentMap.get(scrapProdId);
      const unitCost = comp ? (comp.actual_price || comp.standard_price) : 0;
      totalScrapCost += scrapQty * unitCost;
    }
  }

  // 9. Compute totals
  const goodUnits = Math.max(moQty - totalScrapQty, 1);
  const totalCost = totalMaterialCost + totalLaborCost + totalScrapCost;
  const perUnitCost = totalCost / goodUnits;

  return {
    mo_id: moId,
    mo_name: mo.name,
    product_name: productName,
    quantity: moQty,
    good_units: goodUnits,
    material_cost: totalMaterialCost,
    labor_cost: totalLaborCost,
    scrap_cost: totalScrapCost,
    total_cost: totalCost,
    per_unit_cost: perUnitCost,
    components,
    work_orders: workOrderCosts,
    scrap_records: scrapRecords,
    is_estimate: isEstimate,
    warnings,
  };
}

// =============================================================================
// VARIANCE ANALYSIS
// =============================================================================

export async function calculateVariance(
  client: OdooClient,
  moId: number
): Promise<VarianceResult> {
  // 1. Get MO
  const mos = await client.read<MrpProduction>(
    'mrp.production', [moId],
    ['id', 'name', 'product_id', 'product_qty', 'bom_id']
  );
  if (!mos.length) throw new Error(`MO ID ${moId} not found`);
  const mo = mos[0];

  const productId = mo.product_id ? (mo.product_id as [number, string])[0] : 0;
  const productName = mo.product_id ? (mo.product_id as [number, string])[1] : 'Unknown';
  const moQty = mo.product_qty || 1;
  const bomId = mo.bom_id ? (mo.bom_id as [number, string])[0] : undefined;

  // 2. Standard cost (BOM rollup)
  const standard = await calculateStandardCost(client, productId, moQty, bomId);

  // 3. Actual cost (valuation layers + work orders)
  const actual = await calculateActualCost(client, moId, true);

  // 4. Compute variances
  const totalVariance = makeCostVariance(standard.total_cost, actual.total_cost);
  const materialVariance = makeCostVariance(standard.total_material_cost, actual.material_cost);
  const laborVariance = makeCostVariance(standard.total_labor_cost, actual.labor_cost);

  // 5. Per-component material variance
  const componentVariances: MaterialVariance[] = actual.components.map(comp => {
    const stdPrice = comp.standard_price;
    const actPrice = comp.actual_price;
    const actQty = comp.actual_qty;
    const stdQty = comp.planned_qty || actQty;

    const priceVariance = (actPrice - stdPrice) * actQty;
    const qtyVariance = (actQty - stdQty) * stdPrice;

    return {
      product_id: comp.product_id,
      product_name: comp.product_name,
      price_variance: priceVariance,
      quantity_variance: qtyVariance,
      total_variance: priceVariance + qtyVariance,
    };
  });

  // 6. Per-WC labor variance
  const laborVariances: LaborVariance[] = actual.work_orders.map(wo => {
    const stdHours = wo.expected_duration / 60;
    const actHours = wo.actual_duration / 60;
    const stdRate = wo.costs_hour;
    const actRate = wo.costs_hour;

    return {
      workcenter_id: wo.workcenter_id,
      workcenter_name: wo.workcenter_name,
      rate_variance: (actRate - stdRate) * actHours,
      efficiency_variance: (actHours - stdHours) * stdRate,
      total_variance: ((actRate - stdRate) * actHours) + ((actHours - stdHours) * stdRate),
    };
  });

  // 7. Scrap impact
  const scrapImpact = {
    total_scrap_cost: actual.scrap_cost,
    per_unit_impact: actual.good_units > 0 ? actual.scrap_cost / actual.good_units : 0,
    scrap_rate: actual.quantity > 0
      ? ((actual.quantity - actual.good_units) / actual.quantity) * 100
      : 0,
  };

  const isSignificant = Math.abs(totalVariance.variance_percent) > VARIANCE_THRESHOLDS.SIGNIFICANT_PERCENT;

  return {
    mo_id: moId,
    mo_name: mo.name,
    product_name: productName,
    standard,
    actual,
    total_variance: totalVariance,
    material_variance: materialVariance,
    labor_variance: laborVariance,
    component_variances: componentVariances,
    labor_variances: laborVariances,
    scrap_impact: scrapImpact,
    is_significant: isSignificant,
    warnings: [...standard.warnings, ...actual.warnings],
  };
}

// =============================================================================
// HELPERS
// =============================================================================

async function fetchProductPricesSafe(
  client: OdooClient,
  productIds: number[],
  warnings: string[]
): Promise<ProductProduct[]> {
  if (useStandardPriceFallback) {
    return client.read<ProductProduct>(
      'product.product', productIds,
      ['id', 'standard_cost_manual']
    );
  }

  try {
    return await client.read<ProductProduct>(
      'product.product', productIds,
      ['id', 'standard_price', 'standard_cost_manual']
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('not have enough rights') || errMsg.includes('standard_price')) {
      useStandardPriceFallback = true;
      warnings.push('standard_price access denied — using standard_cost_manual as fallback.');
      return client.read<ProductProduct>(
        'product.product', productIds,
        ['id', 'standard_cost_manual']
      );
    }
    throw error;
  }
}

function makeCostVariance(standardCost: number, actualCost: number): CostVariance {
  const variance = actualCost - standardCost;
  const variancePercent = standardCost !== 0 ? (variance / standardCost) * 100 : 0;
  return {
    standard_cost: standardCost,
    actual_cost: actualCost,
    variance,
    variance_percent: variancePercent,
    favorable: actualCost < standardCost,
  };
}
