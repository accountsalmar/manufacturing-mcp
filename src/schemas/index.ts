/**
 * Zod validation schemas for all Manufacturing MCP tools.
 * Follows crm-mcp pattern: PaginationSchema base, tool-specific extensions.
 */

import { z } from 'zod';
import { CONTEXT_LIMITS, ResponseFormat } from '../constants.js';

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

export const DetailLevelEnum = z.enum(['summary', 'detailed', 'technical'])
  .default('detailed')
  .describe("Output detail level: 'summary' (executives), 'detailed' (managers), 'technical' (accountants)");

export const ResponseFormatEnum = z.nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' or 'json'");

export const FieldPresetEnum = z.enum(['basic', 'extended', 'full']);

export const FieldsParam = z.union([
  FieldPresetEnum,
  z.array(z.string()).min(1).max(100)
]).optional()
  .describe("Fields to return. Use preset name ('basic', 'extended', 'full') or array of field names.");

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(CONTEXT_LIMITS.MAX_PAGE_SIZE)
    .default(CONTEXT_LIMITS.DEFAULT_PAGE_SIZE)
    .describe(`Number of records (1-${CONTEXT_LIMITS.MAX_PAGE_SIZE}, default: ${CONTEXT_LIMITS.DEFAULT_PAGE_SIZE})`),
  offset: z.number().int().min(0).default(0)
    .describe('Records to skip for pagination'),
  response_format: ResponseFormatEnum,
}).strict();

export const DateRangeSchema = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Start date filter (YYYY-MM-DD)'),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('End date filter (YYYY-MM-DD)'),
});

export const MOStateEnum = z.enum(['draft', 'confirmed', 'progress', 'to_close', 'done', 'cancel']);

// =============================================================================
// HEALTH CHECK
// =============================================================================

export const HealthCheckSchema = z.object({
  response_format: ResponseFormatEnum,
}).strict();

export type HealthCheckInput = z.infer<typeof HealthCheckSchema>;

// =============================================================================
// DISCOVERY & LOOKUP (5 tools)
// =============================================================================

export const SearchMOsSchema = PaginationSchema.extend({
  query: z.string().max(200).optional()
    .describe('Search text to match against MO name or origin'),
  state: MOStateEnum.optional()
    .describe('Filter by MO state'),
  product_id: z.number().int().positive().optional()
    .describe('Filter by product ID'),
  partner_id: z.number().int().positive().optional()
    .describe('Filter by customer ID'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('MOs started on or after this date (YYYY-MM-DD)'),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('MOs started on or before this date (YYYY-MM-DD)'),
  fields: FieldsParam,
  detail_level: DetailLevelEnum,
}).strict();

export type SearchMOsInput = z.infer<typeof SearchMOsSchema>;

export const GetMODetailSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetMODetailInput = z.infer<typeof GetMODetailSchema>;

export const GetBomStructureSchema = z.object({
  bom_id: z.number().int().positive().optional()
    .describe('BOM ID to explode (provide this OR product_id)'),
  product_id: z.number().int().positive().optional()
    .describe('Product ID to find BOM for (provide this OR bom_id)'),
  quantity: z.number().positive().default(1)
    .describe('Production quantity to scale BOM (default: 1)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetBomStructureInput = z.infer<typeof GetBomStructureSchema>;

export const SearchProductsSchema = PaginationSchema.extend({
  query: z.string().max(200).optional()
    .describe('Search text to match against product name or internal reference'),
  category_id: z.number().int().positive().optional()
    .describe('Filter by product category ID'),
  product_type: z.enum(['consu', 'product', 'service']).optional()
    .describe("Filter by product type: 'consu' (consumable), 'product' (storable), 'service'"),
}).strict();

export type SearchProductsInput = z.infer<typeof SearchProductsSchema>;

export const GetWorkCenterInfoSchema = z.object({
  workcenter_id: z.number().int().positive().optional()
    .describe('Work center ID (provide this OR name)'),
  name: z.string().max(200).optional()
    .describe('Work center name to search for'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetWorkCenterInfoInput = z.infer<typeof GetWorkCenterInfoSchema>;

// =============================================================================
// COST CALCULATION (4 tools)
// =============================================================================

export const CalculateStandardCostSchema = z.object({
  product_id: z.number().int().positive()
    .describe('Product ID to calculate standard cost for'),
  quantity: z.number().positive().default(1)
    .describe('Production quantity (default: 1)'),
  bom_id: z.number().int().positive().optional()
    .describe('Specific BOM ID to use (optional, auto-detected if not provided)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type CalculateStandardCostInput = z.infer<typeof CalculateStandardCostSchema>;

export const GetActualMOCostSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID'),
  include_scrap: z.boolean().default(true)
    .describe('Include scrap cost in actual cost (default: true)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetActualMOCostInput = z.infer<typeof GetActualMOCostSchema>;

export const CalculateComponentCostsSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID to analyze'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type CalculateComponentCostsInput = z.infer<typeof CalculateComponentCostsSchema>;

export const GetWorkCenterCostsSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetWorkCenterCostsInput = z.infer<typeof GetWorkCenterCostsSchema>;

// =============================================================================
// VARIANCE ANALYSIS (4 tools)
// =============================================================================

export const AnalyzeCostVarianceSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID to analyze variance for'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type AnalyzeCostVarianceInput = z.infer<typeof AnalyzeCostVarianceSchema>;

export const GetMaterialVarianceSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetMaterialVarianceInput = z.infer<typeof GetMaterialVarianceSchema>;

export const GetLaborVarianceSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetLaborVarianceInput = z.infer<typeof GetLaborVarianceSchema>;

export const GetScrapImpactSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetScrapImpactInput = z.infer<typeof GetScrapImpactSchema>;

// =============================================================================
// PRE-PRODUCTION ESTIMATION (3 tools)
// =============================================================================

export const EstimateProductionCostSchema = z.object({
  product_id: z.number().int().positive()
    .describe('Product ID to estimate cost for'),
  quantity: z.number().positive()
    .describe('Production quantity to estimate'),
  bom_id: z.number().int().positive().optional()
    .describe('Specific BOM ID (optional, auto-detected)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type EstimateProductionCostInput = z.infer<typeof EstimateProductionCostSchema>;

export const CompareBomVersionsSchema = z.object({
  bom_id_a: z.number().int().positive()
    .describe('First BOM ID to compare'),
  bom_id_b: z.number().int().positive()
    .describe('Second BOM ID to compare'),
  quantity: z.number().positive().default(1)
    .describe('Production quantity for comparison (default: 1)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type CompareBomVersionsInput = z.infer<typeof CompareBomVersionsSchema>;

export const WhatIfAnalysisSchema = z.object({
  product_id: z.number().int().positive()
    .describe('Product ID for baseline BOM'),
  quantity: z.number().positive()
    .describe('Production quantity'),
  overrides: z.array(z.object({
    type: z.enum(['component_price', 'component_qty', 'labor_rate', 'quantity'])
      .describe('Type of override to apply'),
    target_id: z.number().int().positive().optional()
      .describe('Product ID (for component) or Work Center ID (for labor)'),
    new_value: z.number()
      .describe('New value to apply'),
  })).min(1)
    .describe('List of overrides to apply to the baseline'),
  bom_id: z.number().int().positive().optional()
    .describe('Specific BOM ID (optional, auto-detected)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type WhatIfAnalysisInput = z.infer<typeof WhatIfAnalysisSchema>;

// =============================================================================
// TRENDS & COMPARISON (3 tools)
// =============================================================================

export const GetCostTrendsSchema = z.object({
  product_id: z.number().int().positive()
    .describe('Product ID to analyze cost trends for'),
  granularity: z.enum(['weekly', 'monthly', 'quarterly']).default('monthly')
    .describe('Time grouping: weekly, monthly, or quarterly'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Start date (YYYY-MM-DD)'),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('End date (YYYY-MM-DD)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetCostTrendsInput = z.infer<typeof GetCostTrendsSchema>;

export const CompareMOPerformanceSchema = z.object({
  mo_id: z.number().int().positive()
    .describe('Manufacturing Order ID to compare'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type CompareMOPerformanceInput = z.infer<typeof CompareMOPerformanceSchema>;

export const GetEfficiencySummarySchema = z.object({
  workcenter_id: z.number().int().positive().optional()
    .describe('Filter by work center ID (optional, shows all if omitted)'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Start date (YYYY-MM-DD)'),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('End date (YYYY-MM-DD)'),
  detail_level: DetailLevelEnum,
  response_format: ResponseFormatEnum,
}).strict();

export type GetEfficiencySummaryInput = z.infer<typeof GetEfficiencySummarySchema>;

// =============================================================================
// KNOWLEDGE & CONFIGURATION (2 tools)
// =============================================================================

export const GetCostMethodologySchema = z.object({
  detail_level: DetailLevelEnum,
  section: z.enum(['all', 'cost_rules', 'bom_rules', 'variance_rules', 'data_guards', 'workflow', 'accounting', 'glossary'])
    .default('all')
    .describe('Specific section to return, or all'),
  response_format: ResponseFormatEnum,
}).strict();

export type GetCostMethodologyInput = z.infer<typeof GetCostMethodologySchema>;

export const GetOutputFormatSchema = z.object({
  section: z.enum(['all', 'bom_tree', 'variance_dashboard', 'key_findings', 'detail_levels'])
    .default('all')
    .describe('Specific section to return, or all'),
  response_format: ResponseFormatEnum,
}).strict();

export type GetOutputFormatInput = z.infer<typeof GetOutputFormatSchema>;
