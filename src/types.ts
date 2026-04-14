// Odoo connection configuration
export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

// Generic Odoo record
export interface OdooRecord {
  id: number;
  [key: string]: unknown;
}

// =============================================================================
// Manufacturing Order (mrp.production)
// =============================================================================
export interface MrpProduction extends OdooRecord {
  id: number;
  name: string;                              // Reference (e.g., "MO/00123")
  product_id?: [number, string];             // Finished product
  product_qty?: number;                      // Quantity to produce
  product_uom_id?: [number, string];         // Unit of measure
  bom_id?: [number, string];                 // Bill of Material
  state?: 'draft' | 'confirmed' | 'progress' | 'to_close' | 'done' | 'cancel';
  reservation_state?: 'confirmed' | 'assigned' | 'waiting';
  priority?: string;
  origin?: string;                           // Source document
  // Cost fields (DuraCube custom)
  std_cost?: number;                         // MO Standard Cost
  mo_cost?: number;                          // MO Actual Cost
  l_cost_diff?: number;                      // Labor Difference
  m_cost_diff?: number;                      // Material Difference
  install_cost?: number;                     // Installation Difference
  extra_cost?: number;                       // Extra Unit Cost
  job_revenue?: number;                      // Job Revenue
  // Job fields
  analytic_account_id?: [number, string];    // Job Number
  opportunity_id?: [number, string];         // Linked Opportunity
  job_type?: string;                         // Job Type
  cubicles?: number;                         // Cubicles
  // Dates
  date_start?: string;                       // Actual Start
  date_finished?: string;                    // Actual End
  date_deadline?: string;                    // Deadline
  // Note: date_planned_start/date_planned_finished were removed in Odoo 17
  // Use date_start and date_finished instead
  cm_date?: string;                          // Check Measure Date
  shipping_date?: string;
  install_date?: string;
  install_finish_date?: string;
  complete_date?: string;
  finish_date?: string;
  rff_date?: string;
  fr_date?: string;
  // People
  user_id?: [number, string];                // Responsible
  partner_id?: [number, string];             // Customer
  estimator_id?: [number, string];
  project_manager_id?: [number, string];
  installer?: [number, string];
  factory_user_id?: [number, string];
  site_id?: [number, string];
  // Status
  is_locked?: boolean;
  active?: boolean;
  is_accurate?: boolean;
  accurate_mo?: string;
  // Meta
  company_id?: [number, string];
  create_date?: string;
  write_date?: string;
}

// =============================================================================
// Bill of Materials (mrp.bom)
// =============================================================================
export interface MrpBom extends OdooRecord {
  id: number;
  code?: string;                             // Reference
  active?: boolean;
  type?: 'normal' | 'phantom' | 'subcontract';
  product_tmpl_id?: [number, string];        // Product Template
  product_id?: [number, string];             // Product Variant
  product_qty?: number;                      // Quantity
  product_uom_id?: [number, string];         // UoM
  consumption?: string;                      // Flexible Consumption
  produce_delay?: number;                    // Manufacturing Lead Time (days)
  bom_line_ids?: number[];                   // Component line IDs
  operation_ids?: number[];                  // Operation IDs
  company_id?: [number, string];
  create_date?: string;
  write_date?: string;
}

// =============================================================================
// BOM Line (mrp.bom.line)
// =============================================================================
export interface MrpBomLine extends OdooRecord {
  id: number;
  bom_id?: [number, string];                 // Parent BOM
  product_id?: [number, string];             // Component
  product_qty?: number;                      // Quantity
  product_uom_id?: [number, string];         // UoM
  cost_share?: number;                       // Cost Share (%)
  sequence?: number;
  child_bom_id?: [number, string];           // Sub BoM (for recursive explosion)
  operation_id?: [number, string];           // Consumed in Operation
  company_id?: [number, string];
}

// =============================================================================
// Work Center (mrp.workcenter)
// =============================================================================
export interface MrpWorkcenter extends OdooRecord {
  id: number;
  name: string;
  code?: string;
  active?: boolean;
  costs_hour?: number;                       // Total Cost per hour
  labour_cost_per_hour?: number;             // Labour Cost Per Hour (custom)
  wc_cost_per_hour?: number;                 // WC Cost Per Hour (custom)
  labour_markup?: number;                    // Labour Markup (custom)
  wc_markup?: number;                        // WC Markup (custom)
  employee_costs_hour?: number;              // Employee Hourly Cost
  default_capacity?: number;                 // Capacity
  time_efficiency?: number;                  // Time Efficiency %
  time_start?: number;                       // Setup Time (minutes)
  time_stop?: number;                        // Cleanup Time (minutes)
  oee_target?: number;                       // OEE Target
  sequence?: number;
  center_type?: string;                      // Work Center Type (custom)
  working_state?: 'normal' | 'blocked' | 'done';
  company_id?: [number, string];
}

// =============================================================================
// Work Order (mrp.workorder)
// =============================================================================
export interface MrpWorkorder extends OdooRecord {
  id: number;
  name?: string;
  production_id?: [number, string];          // Manufacturing Order
  workcenter_id?: [number, string];          // Work Center
  operation_id?: [number, string];           // Operation
  product_id?: [number, string];             // Product
  state?: 'pending' | 'waiting' | 'ready' | 'progress' | 'done' | 'cancel';
  duration_expected?: number;                // Expected Duration (minutes)
  duration?: number;                         // Real Duration (minutes)
  duration_unit?: number;                    // Duration Per Unit
  duration_percent?: number;                 // Duration Deviation (%)
  costs_hour?: number;                       // Cost per hour
  date_start?: string;
  date_finished?: string;
  qty_producing?: number;
  qty_produced?: number;
  create_date?: string;
  write_date?: string;
}

// =============================================================================
// Routing Operation (mrp.routing.workcenter)
// =============================================================================
export interface MrpRoutingWorkcenter extends OdooRecord {
  id: number;
  name: string;                              // Operation name
  bom_id?: [number, string];                 // Bill of Material
  workcenter_id?: [number, string];          // Work Center
  sequence?: number;
  time_mode?: string;                        // Duration Computation
  time_cycle_manual?: number;                // Manual Duration (minutes)
  company_id?: [number, string];
}

// =============================================================================
// Stock Move (for material consumption)
// =============================================================================
export interface StockMove extends OdooRecord {
  id: number;
  name?: string;                             // Description
  product_id?: [number, string];             // Product
  quantity?: number;
  product_uom_qty?: number;
  price_unit?: number;                       // Unit Price
  state?: 'draft' | 'waiting' | 'confirmed' | 'partially_available' | 'assigned' | 'done' | 'cancel';
  production_id?: [number, string];          // Production Order (finished goods)
  raw_material_production_id?: [number, string]; // Production Order (components)
  std_cost?: number;                         // Standard Cost (custom)
  cost_share?: number;                       // Cost Share %
  create_date?: string;
}

// =============================================================================
// Stock Scrap
// =============================================================================
export interface StockScrap extends OdooRecord {
  id: number;
  product_id?: [number, string];
  scrap_qty?: number;
  product_uom_id?: [number, string];
  production_id?: [number, string];          // Manufacturing Order
  workorder_id?: [number, string];           // Work Order
  state?: 'draft' | 'done';
  date_done?: string;
  location_id?: [number, string];
  scrap_location_id?: [number, string];
}

// =============================================================================
// Stock Valuation Layer
// =============================================================================
export interface StockValuationLayer extends OdooRecord {
  id: number;
  product_id?: [number, string];
  quantity?: number;
  uom_id?: [number, string];
  unit_cost?: number;
  value?: number;                            // Total Value
  remaining_qty?: number;
  remaining_value?: number;
  stock_move_id?: [number, string];
  description?: string;
  std_cost?: number;                         // Standard Cost (custom)
  create_date?: string;
}

// =============================================================================
// Product (minimal for cost lookups)
// =============================================================================
export interface ProductProduct extends OdooRecord {
  id: number;
  name?: string;
  default_code?: string;                     // Internal Reference
  standard_price?: number;                   // Cost (Odoo standard)
  standard_cost_manual?: number;             // Standard Cost Manual (custom)
  lst_price?: number;                        // Public Price
  uom_id?: [number, string];
  categ_id?: [number, string];               // Product Category
  type?: 'consu' | 'product' | 'service';
  product_tmpl_id?: [number, string];
}

// =============================================================================
// Pagination Response (same pattern as crm-mcp)
// =============================================================================
export interface PaginatedResponse<T> {
  total: number;
  count: number;
  offset: number;
  limit: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
  context_note?: string;
}

// =============================================================================
// Cost Analysis Types (manufacturing-specific)
// =============================================================================

export interface CostVariance {
  standard_cost: number;
  actual_cost: number;
  variance: number;               // actual - standard (positive = unfavorable)
  variance_percent: number;       // (variance / standard) * 100
  favorable: boolean;             // true if actual < standard
}

export interface MoCostBreakdown {
  mo_id: number;
  mo_name: string;
  product_name: string;
  quantity: number;
  good_units: number;
  material_cost: CostVariance;
  labor_cost: CostVariance;
  overhead_cost: CostVariance;
  scrap_cost: number;
  total_cost: CostVariance;
  per_unit_cost: CostVariance;
  is_estimate: boolean;           // true if MO not yet completed
  warnings: string[];
}

// =============================================================================
// BOM Explosion Types
// =============================================================================

export interface BomOperation {
  operation_id: number;
  name: string;
  workcenter_id: number;
  workcenter_name: string;
  duration_expected: number;      // minutes
  costs_hour: number;
  operation_cost: number;         // (duration/60) * costs_hour * qty_ratio
}

export interface BomNode {
  product_id: number;
  product_name: string;
  product_code?: string;          // Internal Reference
  product_type: 'consu' | 'product' | 'service';
  bom_id: number | null;          // null for leaf nodes
  bom_type: 'normal' | 'phantom' | 'subcontract' | null;
  quantity: number;               // scaled to parent quantity
  uom: string;
  standard_price: number;         // per unit
  line_cost: number;              // quantity * standard_price
  is_leaf: boolean;
  depth: number;
  children: BomNode[];
  operations: BomOperation[];     // only at BOM level
}

export interface BomExplosionResult {
  root: BomNode;
  total_material_cost: number;
  total_labor_cost: number;
  total_cost: number;
  per_unit_cost: number;
  quantity: number;
  depth_reached: number;
  warnings: string[];
  cached: boolean;
}

// =============================================================================
// Actual Cost Types
// =============================================================================

export interface ComponentActualCost {
  product_id: number;
  product_name: string;
  planned_qty: number;
  actual_qty: number;
  standard_price: number;
  actual_price: number;           // from stock.move price_unit
  standard_cost: number;          // planned_qty * standard_price
  actual_cost: number;            // actual_qty * actual_price
  variance: number;
}

export interface WorkOrderActualCost {
  workorder_id: number;
  workorder_name: string;
  workcenter_id: number;
  workcenter_name: string;
  expected_duration: number;      // minutes
  actual_duration: number;        // minutes
  costs_hour: number;
  standard_cost: number;          // (expected/60) * costs_hour
  actual_cost: number;            // (actual/60) * costs_hour
  variance: number;
}

export interface ActualCostResult {
  mo_id: number;
  mo_name: string;
  product_name: string;
  quantity: number;
  good_units: number;
  material_cost: number;
  labor_cost: number;
  scrap_cost: number;
  total_cost: number;
  per_unit_cost: number;
  components: ComponentActualCost[];
  work_orders: WorkOrderActualCost[];
  scrap_records: StockScrap[];
  is_estimate: boolean;
  warnings: string[];
}

// =============================================================================
// Variance Analysis Types
// =============================================================================

export interface MaterialVariance {
  product_id: number;
  product_name: string;
  price_variance: number;         // (actual_price - standard_price) * actual_qty
  quantity_variance: number;      // (actual_qty - standard_qty) * standard_price
  total_variance: number;
}

export interface LaborVariance {
  workcenter_id: number;
  workcenter_name: string;
  rate_variance: number;          // (actual_rate - standard_rate) * actual_hours
  efficiency_variance: number;    // (actual_hours - standard_hours) * standard_rate
  total_variance: number;
}

export interface VarianceResult {
  mo_id: number;
  mo_name: string;
  product_name: string;
  standard: BomExplosionResult;
  actual: ActualCostResult;
  total_variance: CostVariance;
  material_variance: CostVariance;
  labor_variance: CostVariance;
  component_variances: MaterialVariance[];
  labor_variances: LaborVariance[];
  scrap_impact: {
    total_scrap_cost: number;
    per_unit_impact: number;      // scrap_cost / good_units
    scrap_rate: number;           // scrap_qty / (good_qty + scrap_qty)
  };
  is_significant: boolean;        // abs(variance_percent) > 10
  warnings: string[];
}
