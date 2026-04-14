/**
 * Cost Calculator Service
 *
 * Computes standard cost, actual cost, and variance for Manufacturing Orders.
 * Uses BOM service for standard cost, stock moves + work orders for actual cost.
 */

import type { OdooClient } from './odoo-client.js';
import { explodeBom, getProductBom } from './bom-service.js';
import type {
  MrpProduction, MrpWorkorder, MrpWorkcenter, StockMove, StockScrap, ProductProduct,
  BomExplosionResult, ActualCostResult, ComponentActualCost, WorkOrderActualCost,
  VarianceResult, CostVariance, MaterialVariance, LaborVariance,
} from '../types.js';
import { MFG_FIELDS, VARIANCE_THRESHOLDS } from '../constants.js';

// =============================================================================
// STANDARD COST
// =============================================================================

export async function calculateStandardCost(
  client: OdooClient,
  productId: number,
  quantity: number = 1,
  bomId?: number
): Promise<BomExplosionResult> {
  // Resolve BOM
  let resolvedBomId = bomId;
  if (!resolvedBomId) {
    const bom = await getProductBom(client, productId);
    if (!bom) throw new Error(`No BOM found for product ID ${productId}`);
    resolvedBomId = bom.id;
  }

  return explodeBom(client, resolvedBomId, quantity);
}

// =============================================================================
// ACTUAL COST
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

  // Build component costs
  const componentMap = new Map<number, ComponentActualCost>();
  let totalMaterialCost = 0;

  for (const move of rawMoves) {
    const prodId = move.product_id ? (move.product_id as [number, string])[0] : 0;
    const prodName = move.product_id ? (move.product_id as [number, string])[1] : 'Unknown';
    const qty = move.quantity || move.product_uom_qty || 0;
    const unitCost = move.price_unit || 0;
    const lineCost = qty * unitCost;

    if (unitCost === 0 && qty > 0) {
      warnings.push(`Unvalued stock move for "${prodName}" (ID: ${move.id}) — using zero cost.`);
    }

    const existing = componentMap.get(prodId);
    if (existing) {
      existing.actual_qty += qty;
      existing.actual_cost += lineCost;
      // Weighted average actual price
      existing.actual_price = existing.actual_qty > 0 ? existing.actual_cost / existing.actual_qty : 0;
    } else {
      componentMap.set(prodId, {
        product_id: prodId,
        product_name: prodName,
        planned_qty: 0,     // Will be filled from BOM if available
        actual_qty: qty,
        standard_price: 0,  // Will be filled from product
        actual_price: unitCost,
        standard_cost: 0,
        actual_cost: lineCost,
        variance: 0,
      });
    }

    totalMaterialCost += lineCost;
  }

  // Fetch standard prices for components
  const productIds = Array.from(componentMap.keys());
  if (productIds.length > 0) {
    const products = await client.read<ProductProduct>(
      'product.product', productIds,
      ['id', 'standard_price', 'standard_cost_manual']
    );
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

  // 3. Fetch work orders + work center costs
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

    // Get work center hourly rate
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

  // 4. Fetch scrap
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

      // Estimate scrap cost from product standard price
      const scrapProdId = scrap.product_id ? (scrap.product_id as [number, string])[0] : 0;
      const comp = componentMap.get(scrapProdId);
      const unitCost = comp ? (comp.actual_price || comp.standard_price) : 0;
      totalScrapCost += scrapQty * unitCost;
    }
  }

  // 5. Compute totals
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
  // 1. Get MO to find product, qty, bom
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

  // 2. Calculate standard cost
  const standard = await calculateStandardCost(client, productId, moQty, bomId);

  // 3. Calculate actual cost
  const actual = await calculateActualCost(client, moId, true);

  // 4. Compute variances
  const totalVariance = makeCostVariance(standard.total_cost, actual.total_cost);
  const materialVariance = makeCostVariance(standard.total_material_cost, actual.material_cost);
  const laborVariance = makeCostVariance(standard.total_labor_cost, actual.labor_cost);

  // 5. Per-component material variance
  const componentVariances: MaterialVariance[] = actual.components.map(comp => {
    // Try to find matching standard component from BOM
    const stdPrice = comp.standard_price;
    const actPrice = comp.actual_price;
    const actQty = comp.actual_qty;
    const stdQty = comp.planned_qty || actQty; // fallback

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
    const actRate = wo.costs_hour; // Same rate for both (no rate variance typically)

    const rateVariance = (actRate - stdRate) * actHours;
    const efficiencyVariance = (actHours - stdHours) * stdRate;

    return {
      workcenter_id: wo.workcenter_id,
      workcenter_name: wo.workcenter_name,
      rate_variance: rateVariance,
      efficiency_variance: efficiencyVariance,
      total_variance: rateVariance + efficiencyVariance,
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

  const warnings = [...standard.warnings, ...actual.warnings];

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
    warnings,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

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
