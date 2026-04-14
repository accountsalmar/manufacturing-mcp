// Context limits for managing response sizes (same as crm-mcp)
export const CONTEXT_LIMITS = {
  MAX_RESPONSE_CHARS: 8000,
  DEFAULT_PAGE_SIZE: 10,
  MAX_PAGE_SIZE: 50,
  SUMMARY_THRESHOLD: 20,
  MAX_FIELDS_DETAIL: 15,
  MAX_FIELDS_LIST: 8,
} as const;

// Response format options
export enum ResponseFormat {
  JSON = 'json',
  MARKDOWN = 'markdown',
}

// Detail level for multi-audience output
export type DetailLevel = 'summary' | 'detailed' | 'technical';

// =============================================================================
// FIELD ARRAYS - per Odoo model
// =============================================================================
export const MFG_FIELDS = {
  // Manufacturing Order - list view (context-efficient)
  MO_LIST: [
    'id', 'name', 'product_id', 'product_qty', 'state',
    'std_cost', 'mo_cost', 'partner_id', 'user_id',
    'analytic_account_id', 'date_start', 'date_finished',
  ] as string[],

  // Manufacturing Order - extended
  MO_LIST_EXTENDED: [
    'id', 'name', 'product_id', 'product_qty', 'product_uom_id',
    'bom_id', 'state', 'reservation_state', 'priority',
    'std_cost', 'mo_cost', 'l_cost_diff', 'm_cost_diff', 'install_cost',
    'extra_cost', 'job_revenue',
    'partner_id', 'user_id', 'analytic_account_id', 'opportunity_id',
    'job_type', 'origin',
    'date_start', 'date_finished', 'date_deadline',
    'date_planned_start', 'date_planned_finished',
    'estimator_id', 'project_manager_id',
  ] as string[],

  // Manufacturing Order - full detail
  MO_DETAIL: [
    'id', 'name', 'product_id', 'product_qty', 'product_uom_id',
    'bom_id', 'state', 'reservation_state', 'priority',
    'std_cost', 'mo_cost', 'l_cost_diff', 'm_cost_diff', 'install_cost',
    'extra_cost', 'job_revenue', 'cubicles', 'accurate_mo', 'is_accurate',
    'partner_id', 'user_id', 'company_id',
    'analytic_account_id', 'opportunity_id', 'job_type', 'origin',
    'date_start', 'date_finished', 'date_deadline',
    'date_planned_start', 'date_planned_finished',
    'cm_date', 'shipping_date', 'install_date', 'install_finish_date',
    'complete_date', 'finish_date', 'rff_date', 'fr_date',
    'estimator_id', 'project_manager_id', 'installer',
    'factory_user_id', 'site_id',
    'active', 'is_locked', 'create_date', 'write_date',
  ] as string[],

  // BOM - list view
  BOM_LIST: [
    'id', 'code', 'product_tmpl_id', 'product_id', 'type',
    'product_qty', 'product_uom_id', 'active',
  ] as string[],

  // BOM - full detail
  BOM_DETAIL: [
    'id', 'code', 'product_tmpl_id', 'product_id', 'type',
    'product_qty', 'product_uom_id', 'active',
    'consumption', 'produce_delay',
    'bom_line_ids', 'operation_ids',
    'company_id', 'create_date', 'write_date',
  ] as string[],

  // BOM Line
  BOM_LINE: [
    'id', 'bom_id', 'product_id', 'product_qty', 'product_uom_id',
    'cost_share', 'sequence', 'child_bom_id', 'operation_id',
  ] as string[],

  // Work Center - list view
  WORKCENTER_LIST: [
    'id', 'name', 'code', 'active', 'costs_hour',
    'labour_cost_per_hour', 'wc_cost_per_hour',
    'labour_markup', 'wc_markup',
    'default_capacity', 'time_efficiency',
    'time_start', 'time_stop', 'center_type', 'sequence',
  ] as string[],

  // Work Order
  WORKORDER_LIST: [
    'id', 'name', 'production_id', 'workcenter_id', 'operation_id',
    'product_id', 'state', 'duration_expected', 'duration',
    'duration_unit', 'duration_percent', 'costs_hour',
    'date_start', 'date_finished',
  ] as string[],

  // Routing Operation
  ROUTING_OPERATION: [
    'id', 'name', 'bom_id', 'workcenter_id', 'sequence',
    'time_mode', 'time_cycle_manual',
  ] as string[],

  // Stock Move (material consumption)
  STOCK_MOVE_MO: [
    'id', 'name', 'product_id', 'quantity', 'product_uom_qty',
    'price_unit', 'state', 'production_id',
    'raw_material_production_id', 'std_cost', 'cost_share',
  ] as string[],

  // Stock Scrap
  STOCK_SCRAP: [
    'id', 'product_id', 'scrap_qty', 'product_uom_id',
    'production_id', 'workorder_id', 'state', 'date_done',
  ] as string[],

  // Stock Valuation Layer
  VALUATION_LAYER: [
    'id', 'product_id', 'quantity', 'unit_cost', 'value',
    'remaining_qty', 'remaining_value', 'stock_move_id',
    'description', 'std_cost', 'create_date',
  ] as string[],

  // Product (cost lookup)
  PRODUCT_COST: [
    'id', 'name', 'default_code', 'standard_price',
    'standard_cost_manual', 'lst_price', 'uom_id', 'categ_id', 'type',
    'product_tmpl_id',
  ] as string[],
} as const;

// =============================================================================
// FIELD PRESETS - Named field sets for dynamic column selection
// =============================================================================
export const FIELD_PRESETS: Record<string, Record<string, string[]>> = {
  mo: {
    basic: MFG_FIELDS.MO_LIST as unknown as string[],
    extended: MFG_FIELDS.MO_LIST_EXTENDED as unknown as string[],
    full: MFG_FIELDS.MO_DETAIL as unknown as string[],
  },
  bom: {
    basic: MFG_FIELDS.BOM_LIST as unknown as string[],
    full: MFG_FIELDS.BOM_DETAIL as unknown as string[],
  },
  workcenter: {
    basic: MFG_FIELDS.WORKCENTER_LIST as unknown as string[],
  },
  workorder: {
    basic: MFG_FIELDS.WORKORDER_LIST as unknown as string[],
  },
  product: {
    basic: MFG_FIELDS.PRODUCT_COST as unknown as string[],
  },
};

/**
 * Resolve a fields parameter to an actual array of field names.
 * Handles: undefined -> default preset, string -> preset lookup, string[] -> as-is
 */
export function resolveFields(
  fieldsParam: string | string[] | undefined,
  modelType: 'mo' | 'bom' | 'workcenter' | 'workorder' | 'product' = 'mo',
  defaultPreset: string = 'basic'
): string[] {
  if (fieldsParam === undefined || fieldsParam === null) {
    const presets = FIELD_PRESETS[modelType];
    return presets?.[defaultPreset] || MFG_FIELDS.MO_LIST as unknown as string[];
  }

  if (typeof fieldsParam === 'string') {
    const presets = FIELD_PRESETS[modelType];
    const preset = presets?.[fieldsParam];
    if (preset) return preset;
    console.error(`[resolveFields] Unknown preset "${fieldsParam}" for ${modelType}, using default`);
    return FIELD_PRESETS[modelType]?.[defaultPreset] || MFG_FIELDS.MO_LIST as unknown as string[];
  }

  if (Array.isArray(fieldsParam)) return fieldsParam;

  return FIELD_PRESETS[modelType]?.[defaultPreset] || MFG_FIELDS.MO_LIST as unknown as string[];
}

// =============================================================================
// INFRASTRUCTURE CONFIG
// =============================================================================

// Circuit breaker configuration
export const CIRCUIT_BREAKER_CONFIG = {
  FAILURE_THRESHOLD: 5,
  RESET_TIMEOUT_MS: 60000,
  HALF_OPEN_MAX_ATTEMPTS: 1,
} as const;

// Connection pool configuration
export const POOL_CONFIG = {
  MIN: parseInt(process.env.ODOO_POOL_MIN || '2'),
  MAX: parseInt(process.env.ODOO_POOL_MAX || '10'),
  ACQUIRE_TIMEOUT_MS: parseInt(process.env.ODOO_POOL_ACQUIRE_TIMEOUT || '30000'),
  IDLE_TIMEOUT_MS: parseInt(process.env.ODOO_POOL_IDLE_TIMEOUT || '300000'),
  EVICTION_RUN_INTERVAL_MS: parseInt(process.env.ODOO_POOL_EVICTION_INTERVAL || '60000'),
  TEST_ON_BORROW: process.env.ODOO_POOL_TEST_ON_BORROW !== 'false',
  FIFO: true,
} as const;

// =============================================================================
// COST ANALYSIS CONFIG
// =============================================================================

// Variance significance thresholds
export const VARIANCE_THRESHOLDS = {
  MINOR_PERCENT: 5,              // <= 5% = ON TARGET
  SIGNIFICANT_PERCENT: 10,       // > 10% = SIGNIFICANT
  CRITICAL_PERCENT: 25,          // > 25% = CRITICAL
  SCRAP_WARNING_PERCENT: 5,      // > 5% scrap rate = warning
  SCRAP_CRITICAL_PERCENT: 15,    // > 15% scrap rate = critical
} as const;

// Variance status labels
export function getVarianceStatus(variancePercent: number): string {
  const absPercent = Math.abs(variancePercent);
  if (variancePercent < 0) return 'FAVORABLE';
  if (absPercent <= VARIANCE_THRESHOLDS.MINOR_PERCENT) return 'ON TARGET';
  if (absPercent <= VARIANCE_THRESHOLDS.SIGNIFICANT_PERCENT) return 'UNFAVORABLE';
  if (absPercent <= VARIANCE_THRESHOLDS.CRITICAL_PERCENT) return 'SIGNIFICANT';
  return 'CRITICAL';
}
