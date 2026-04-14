# Manufacturing MCP Server — Build Plan

## Overview

Build `manufacturing-mcp`, a TypeScript MCP server that connects to Odoo via read-only XML-RPC to provide Manufacturing Order cost analysis. It exposes **21 tools** across 6 categories: discovery/lookup, cost calculation, variance analysis, pre-production estimation, trends/comparison, and knowledge/configuration.

**Why**: No current tooling for analyzing MO costs from Odoo. Cost variance analysis, BOM rollups, and efficiency tracking require manual spreadsheet work. This MCP gives Claude direct access to manufacturing cost intelligence.

**Reference architectures**:
- **crm-mcp** (`crm-mcp/`) — Reporting pattern: dual transport, Odoo XML-RPC, connection pool, circuit breaker, Zod schemas, field presets, pagination, formatters, LRU cache
- **duracube-contract-mcp** (`customer_contract_review/`) — Knowledge pattern: JSON domain rules, methodology encoding, validation tools

---

## Stages

### Stage 1: Project Scaffold
**Goal:** Initialize the project with all configuration files, install dependencies
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `manufacturing-mcp/` directory
- [ ] Create `package.json` (adapt from crm-mcp: name `odoo-manufacturing-mcp-server`, remove exceljs/ioredis, add prebuild+copy-json scripts)
- [ ] Create `tsconfig.json` (copy from crm-mcp: ES2022, NodeNext, strict)
- [ ] Create `.env.example` (Odoo connection vars, TRANSPORT, PORT=3001)
- [ ] Create `.gitignore` (node_modules, dist, .env, *.log)
- [ ] Create `railway.json` (copy from crm-mcp: NIXPACKS, healthcheck /health)
- [ ] Run `npm install`

**Tests (Claude Code - stdio):**
- [ ] `npm install` completes without errors
- [ ] All dependencies listed in node_modules/

**Tests (claude.ai - HTTP):**
- [ ] N/A — no server yet

**Success Criteria:**
- Clean npm install with all dependencies resolved
- tsconfig.json configured and ready for compilation

---

### Stage 2: Utils Layer
**Goal:** Copy infrastructure utilities (cache, circuit breaker, retry, timeout) from crm-mcp
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/utils/timeout.ts` — copy from crm-mcp, remove EXPORT_BATCH timeout
- [ ] Create `src/utils/retry.ts` — copy verbatim from crm-mcp (retryable/non-retryable patterns, executeWithRetry)
- [ ] Create `src/utils/circuit-breaker.ts` — copy verbatim from crm-mcp (CLOSED/OPEN/HALF_OPEN states)
- [ ] Create `src/utils/cache-interface.ts` — copy verbatim from crm-mcp (CacheProvider interface)
- [ ] Create `src/utils/cache-memory.ts` — adapt from crm-mcp: change CACHE_TTL to manufacturing keys (WORKCENTERS 30min, BOM 15min, PRODUCTS 15min, BOM_EXPLOSION 10min), change CACHE_KEYS to `mfg:` prefix
- [ ] Create `src/utils/cache.ts` — adapt from crm-mcp: remove Redis branch, memory-only factory

**Tests (Claude Code - stdio):**
- [ ] Create minimal `src/index.ts` stub with `console.log('ok')`
- [ ] `npx tsc --noEmit` compiles all utils without errors

**Tests (claude.ai - HTTP):**
- [ ] N/A — infrastructure only

**Success Criteria:**
- All 6 util files compile cleanly
- No circular dependencies between utils

---

### Stage 3: Types and Constants
**Goal:** Define all TypeScript interfaces for 10 Odoo models and field configuration
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/types.ts` with interfaces for:
  - `OdooConfig`, `OdooRecord` (base — copy from crm-mcp)
  - `MrpProduction` — name, product_id, bom_id, state, dates, custom cost fields (std_cost, mo_cost, l_cost_diff, m_cost_diff, install_cost, extra_cost, job_revenue), job fields, people fields
  - `MrpBom` — product_tmpl_id, type (normal/phantom), product_qty
  - `MrpBomLine` — bom_id, product_id, product_qty, cost_share, child_bom_id, operation_id
  - `MrpWorkcenter` — costs_hour, labour_cost_per_hour, wc_cost_per_hour, default_capacity, time_efficiency
  - `MrpWorkorder` — production_id, workcenter_id, duration_expected, duration, costs_hour
  - `MrpRoutingWorkcenter` — bom_id, workcenter_id, time_cycle_manual
  - `StockMove` — product_id, quantity, price_unit, production_id, raw_material_production_id
  - `StockScrap` — product_id, scrap_qty, production_id
  - `StockValuationLayer` — unit_cost, quantity, value, stock_move_id
  - `ProductProduct` — standard_price, standard_cost_manual, categ_id, type
  - `PaginatedResponse<T>` (copy from crm-mcp)
  - `CostVariance`, `MoCostBreakdown`, `BomNode`, `BomOperation`, `BomExplosionResult`
- [ ] Create `src/constants.ts` with:
  - `CONTEXT_LIMITS` (MAX_RESPONSE_CHARS: 8000, DEFAULT_PAGE_SIZE: 10, MAX_PAGE_SIZE: 50)
  - `ResponseFormat` enum (MARKDOWN, JSON)
  - `MFG_FIELDS` — field arrays per model: MO_LIST (~12), MO_EXTENDED (~25), MO_DETAIL (~40+), BOM_LIST, BOM_LINE, WORKCENTER_LIST, WORKORDER_LIST, ROUTING_OPERATION, STOCK_MOVE_MO, STOCK_SCRAP, VALUATION_LAYER, PRODUCT_COST
  - `FIELD_PRESETS` — { mo: {basic, extended, full}, bom: {basic}, workcenter: {basic}, workorder: {basic} }
  - `resolveFields()` function (same pattern as crm-mcp)
  - `CIRCUIT_BREAKER_CONFIG`, `POOL_CONFIG` (copy from crm-mcp)
- [ ] Run `fields_get` on each Odoo model to verify custom field names exist

**Tests (Claude Code - stdio):**
- [ ] `npx tsc --noEmit` compiles types + constants cleanly
- [ ] Field arrays reference only fields that exist in Odoo (verified via fields_get)

**Tests (claude.ai - HTTP):**
- [ ] N/A — type definitions only

**Success Criteria:**
- All 10 model interfaces defined with correct many2one tuple types `[number, string]`
- Field arrays match actual Odoo instance fields
- No TypeScript errors

---

### Stage 4: Services Layer (Odoo Client + Pool)
**Goal:** Working Odoo XML-RPC client with connection pooling and circuit breaker
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/services/shared-circuit-breaker.ts` — copy from crm-mcp, update imports
- [ ] Create `src/services/odoo-client.ts` — adapt from crm-mcp:
  - Keep: authenticate(), searchRead(), searchCount(), read(), readGroup(), fieldsGet(), circuit breaker integration, singleton pattern, warmCache()
  - Remove: CRM-specific cached methods (stages, lost reasons, teams, salespeople), export/pagination methods
  - Add: `getWorkcentersCached()` for manufacturing reference data
  - Update imports to manufacturing types
- [ ] Create `src/services/odoo-pool.ts` — adapt from crm-mcp (import path changes only): factory, getPool, acquireClient, releaseClient, useClient, getPoolMetrics, warmPool

**Tests (Claude Code - stdio):**
- [ ] `npx tsc --noEmit` compiles services cleanly
- [ ] Create test script: authenticate to Odoo, call `searchRead('mrp.production', [], ['name'], {limit: 1})`, verify response

**Tests (claude.ai - HTTP):**
- [ ] N/A — no server endpoint yet

**Success Criteria:**
- OdooClient authenticates successfully
- searchRead returns manufacturing order data
- Connection pool creates and recycles clients
- Circuit breaker activates on connection failure

---

### Stage 5: Entry Point + Health Check Tool
**Goal:** Working MCP server with dual transport (stdio + HTTP) and health check tool
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/services/formatters.ts` — base utilities only:
  - `formatCurrency()` (Intl.NumberFormat en-AU, AUD)
  - `formatPercent()`, `formatDate()`, `formatDuration()` (minutes → "Xh Ym")
  - `getRelationName()` (extract name from [id, name] tuple)
  - `truncateText()`
- [ ] Create `src/schemas/index.ts` — foundation schemas:
  - `PaginationSchema` (limit, offset, response_format)
  - `DetailLevelEnum` — z.enum(['summary', 'detailed', 'technical']).default('detailed')
  - `FieldsParam` — z.union([preset string, string array])
  - `HealthCheckSchema`
- [ ] Create `src/tools/register-all.ts` — stub with single `odoo_mfg_health_check` tool
- [ ] Create `src/index.ts` — adapt from crm-mcp:
  - Server name: `odoo-manufacturing-mcp-server`
  - Import registerAllTools from register-all
  - Port 3001 (avoid crm-mcp conflict)
  - Dual transport: stdio (default) + HTTP (Express)
  - Global error handlers, async warmup

**Tests (Claude Code - stdio):**
- [ ] `npm run build` compiles cleanly
- [ ] `npx tsx src/index.ts` starts in stdio mode without errors
- [ ] Health check tool responds with Odoo connectivity status, pool metrics, cache stats

**Tests (claude.ai - HTTP):**
- [ ] `TRANSPORT=http npx tsx src/index.ts` starts HTTP server
- [ ] `curl http://localhost:3001/health` returns `{"status":"ok"}`
- [ ] POST to `/mcp` with tools/list returns `odoo_mfg_health_check`
- [ ] POST to `/mcp` with tools/call for health_check returns metrics

**Success Criteria:**
- Server starts in both stdio and HTTP mode
- Health check tool verifies Odoo connection
- Foundation is complete — ready to add domain tools

---

### Stage 6: Knowledge Layer (2 tools)
**Goal:** Domain rules encoded in JSON, served by knowledge tools
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/knowledge/cost-methodology.json`:
  - `global_methodology_rules[]` — 10 rules: COST-001 (standard formula), COST-002 (actual formula), BOM-001 (phantom explosion), BOM-002 (quantity scaling), VAR-001 (sign convention), VAR-002 (material variance), VAR-003 (labor variance), SCRAP-001 (÷ good units), GUARD-001 (zero prices), GUARD-002 (currency/rounding)
  - `significance_thresholds` — variance 10%/25%, scrap 5%/15%
  - `workflow_guidance` — recommended tool chain, aggregation-first rule
  - `terminology` — three tiers: summary (plain English), detailed (formulas + explanations), technical (Odoo models + GL references)
- [ ] Create `src/knowledge/output-format.json`:
  - `bom_tree_format` — connector chars (├── └── │), line format, example
  - `variance_dashboard_format` — columns, status indicators (ON TARGET/FAVORABLE/UNFAVORABLE/SIGNIFICANT/CRITICAL), example
  - `key_findings_format` — max 5 items, priority order, example
  - `detail_level_rules` — summary/detailed/technical display rules
- [ ] Create `src/tools/knowledge-tools.ts` — 2 tools:
  - `get_cost_methodology` — lazy-load JSON, filter by section param, adapt terminology to detail_level
  - `get_output_format` — lazy-load JSON, filter by section param
- [ ] Add `GetCostMethodologySchema`, `GetOutputFormatSchema` to schemas
- [ ] Update `register-all.ts` to include knowledge tools
- [ ] Update `copy-json` script in package.json to copy both knowledge files

**Tests (Claude Code - stdio):**
- [ ] `get_cost_methodology` with detail_level=summary returns plain English glossary
- [ ] `get_cost_methodology` with section=variance_rules returns only variance rules
- [ ] `get_output_format` returns tree format specification
- [ ] Both tools work without Odoo connection (standalone JSON)

**Tests (claude.ai - HTTP):**
- [ ] POST tools/call for `get_cost_methodology` returns structured JSON
- [ ] POST tools/call for `get_output_format` returns format spec

**Success Criteria:**
- Domain rules encoded and accessible
- Terminology adapts to detail_level parameter
- Section filtering works correctly
- Tools load without Odoo dependency

---

### Stage 7: BOM Service + Discovery Tools (5 tools)
**Goal:** Recursive BOM explosion service and 5 discovery/lookup tools
**Estimated effort:** Complex

**Tasks:**
- [ ] Create `src/services/bom-service.ts`:
  - `explodeBom(client, bomId, quantity, visitedBomIds?)` — recursive algorithm:
    1. Circular detection (visitedBomIds set)
    2. Cache check (key = `bom_explosion:${bomId}:${quantity}`, 10min TTL)
    3. Fetch BOM header + lines + operations
    4. Scale quantities by bomQtyRatio (quantity / bom.product_qty)
    5. For each line: fetch product, check for child BOM
    6. Phantom/manufactured with child BOM → RECURSE
    7. Otherwise → LEAF NODE (use standard_price)
    8. Flag zero standard_price as warning
    9. Compute totals: material (leaf costs) + labor (operation costs)
    10. Cache result
  - `getProductBom(client, productId)` — find primary BOM
  - `getBomTree(client, productId, quantity)` — convenience wrapper
- [ ] Create `src/tools/discovery-tools.ts` — 5 tools (build order):
  1. `search_products` — searchRead product.product with name/category/type filters, paginated
  2. `get_work_center_info` — read mrp.workcenter by ID or search by name
  3. `search_manufacturing_orders` — searchRead mrp.production with state/product/date/partner filters, paginated
  4. `get_mo_detail` — read mrp.production + fetch linked workorders, stock moves, scrap
  5. `get_bom_structure` — delegates to bomService.explodeBom(), formats as tree
- [ ] Add 5 Zod schemas: SearchMOsSchema, GetMODetailSchema, GetBomStructureSchema, SearchProductsSchema, GetWorkCenterInfoSchema
- [ ] Add formatters: formatMOList(), formatMODetail(), formatBomTree() (recursive with ├── └── │ connectors), formatProductList(), formatWorkCenterInfo()
- [ ] Update register-all.ts

**Tests (Claude Code - stdio):**
- [ ] `search_manufacturing_orders` with state=done returns paginated list
- [ ] `search_manufacturing_orders` with offset=10 returns next page
- [ ] `get_mo_detail` returns MO with linked work orders and stock moves
- [ ] `get_bom_structure` for single-level BOM returns flat component list with costs
- [ ] `get_bom_structure` for multi-level BOM returns nested tree
- [ ] `get_bom_structure` for phantom BOM auto-explodes (phantom never appears as leaf)
- [ ] Second call to `get_bom_structure` hits cache (faster response)
- [ ] `search_products` returns products with standard_price
- [ ] `get_work_center_info` returns hourly cost and capacity

**Tests (claude.ai - HTTP):**
- [ ] All 5 tools appear in tools/list response
- [ ] Search MOs via HTTP returns markdown-formatted list
- [ ] BOM structure via HTTP returns tree with connectors

**Success Criteria:**
- BOM explosion correctly handles single-level, multi-level, and phantom BOMs
- Circular BOM detection works (no infinite loops)
- Pagination works with offset/limit/has_more
- Cache reduces API calls on repeated BOM queries
- All formatters produce clean markdown output

---

### Stage 8: Cost Calculator + Cost Tools (4 tools)
**Goal:** Standard and actual cost computation engine, plus 4 cost tools
**Estimated effort:** Complex

**Tasks:**
- [ ] Create `src/services/cost-calculator.ts`:
  - `calculateStandardCost(client, productId, qty, bomId?)` — resolve BOM → call explodeBom → return BomExplosionResult
  - `calculateActualCost(client, moId)`:
    1. Fetch MO, validate state (flag WIP if not done/to_close)
    2. Fetch consumed stock.moves (raw_material_production_id = moId, state = done)
    3. Material cost = sum(move.price_unit * move.quantity) per component
    4. Fetch work orders + workcenter rates → labor = (duration/60) * costs_hour
    5. Fetch scrap → scrap cost = sum(scrap_qty * standard_price)
    6. Per-unit = total / good_units (product_qty - scrap_qty)
    7. Return with component/WO/scrap breakdowns + warnings
  - `calculateVariance(client, moId)`:
    1. standard = calculateStandardCost()
    2. actual = calculateActualCost()
    3. Total/material/labor variance with sign convention (positive = unfavorable)
    4. Per-component: price_variance + quantity_variance
    5. Per-WC: rate_variance + efficiency_variance
    6. Scrap impact: scrap_cost / good_units
    7. Flag significance (>10% significant, >25% critical)
- [ ] Create `src/tools/cost-tools.ts` — 4 tools:
  1. `calculate_standard_cost` — BOM tree + key findings
  2. `calculate_component_costs` — per-component standard vs actual comparison table
  3. `get_work_center_costs` — per-WC expected vs actual duration * rate
  4. `get_actual_mo_cost` — actual cost breakdown + key findings
- [ ] Add 4 Zod schemas
- [ ] Add formatters: formatStandardCost(), formatActualCost(), formatComponentCosts(), formatWorkCenterCosts()

**Tests (Claude Code - stdio):**
- [ ] `calculate_standard_cost` for known product matches manual BOM rollup
- [ ] `get_actual_mo_cost` for completed MO — verify total aligns with Odoo's `mo_cost` field
- [ ] `get_actual_mo_cost` for WIP MO — verify `is_estimate: true` flag
- [ ] `calculate_component_costs` shows planned vs actual qty/price per component
- [ ] `get_work_center_costs` shows expected vs actual hours per WC
- [ ] Zero standard_price triggers data quality warning
- [ ] MO with no work orders uses material-only costing

**Tests (claude.ai - HTTP):**
- [ ] All 4 cost tools appear in tools/list
- [ ] Standard cost returns BOM tree format via HTTP
- [ ] Actual cost returns cost breakdown format via HTTP

**Success Criteria:**
- Standard cost matches BOM rollup calculation
- Actual cost includes materials + labor + scrap
- Per-unit cost divides by GOOD units (not total)
- WIP MOs flagged as estimates
- Data quality warnings for zero prices / missing data

---

### Stage 9: Variance Analysis Tools (4 tools)
**Goal:** Full variance analysis with material/labor/scrap breakdown
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/tools/variance-tools.ts` — 4 tools:
  1. `analyze_cost_variance` — calls calculateVariance(), produces three-part output:
     - Part 1: BOM cost tree with variance annotations
     - Part 2: Variance dashboard table (Category | Standard | Actual | Variance | % | Status)
     - Part 3: Key findings (max 5, priority-ordered)
  2. `get_material_variance` — per-component price variance + quantity variance table
  3. `get_labor_variance` — per-WC rate variance + efficiency variance table
  4. `get_scrap_impact` — scrap records for MO, per-unit impact (÷ GOOD units), scrap rate %
- [ ] Add 4 Zod schemas
- [ ] Add formatters: formatVarianceDashboard(), formatKeyFindings(), formatMaterialVariance(), formatLaborVariance(), formatScrapImpact()
- [ ] Implement status indicators: ON TARGET (<=5%), FAVORABLE (actual < standard), UNFAVORABLE (5-10%), SIGNIFICANT (>10%), CRITICAL (>25%)

**Tests (Claude Code - stdio):**
- [ ] `analyze_cost_variance` for completed MO produces all 3 output parts
- [ ] Variance sign: positive = unfavorable, negative = favorable
- [ ] Variance >10% flagged as SIGNIFICANT in dashboard
- [ ] `get_material_variance` shows price + quantity breakdown per component
- [ ] `get_labor_variance` shows rate + efficiency breakdown per WC
- [ ] `get_scrap_impact` divides scrap cost by GOOD units (not total)
- [ ] Scrap rate = scrap_qty / (good_qty + scrap_qty)

**Tests (claude.ai - HTTP):**
- [ ] `analyze_cost_variance` returns formatted three-part output via HTTP
- [ ] Variance dashboard table renders correctly in markdown

**Success Criteria:**
- Three-part output format matches output-format.json spec
- Sign convention correct throughout (positive = over budget)
- Significance thresholds applied correctly
- Scrap calculation uses GOOD units denominator

---

### Stage 10: Estimation Tools (3 tools)
**Goal:** Pre-production cost estimation and what-if analysis
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/tools/estimation-tools.ts` — 3 tools:
  1. `estimate_production_cost` — same as calculateStandardCost but positioned for planning (no MO needed). Input: product_id + quantity. Returns BOM tree + cost estimate
  2. `compare_bom_versions` — explode both BOMs with same quantity, side-by-side comparison with delta column showing component differences and cost impact
  3. `what_if_analysis` — explode baseline BOM, deep-clone tree, apply overrides:
     - `component_price`: change a component's unit cost
     - `component_qty`: change a component's quantity
     - `labor_rate`: change a work center's hourly rate
     - `quantity`: change production quantity (re-explode)
     - Recalculate totals, produce delta dashboard (baseline vs scenario)
- [ ] Add 3 Zod schemas (WhatIfAnalysisSchema has `overrides` array with type/target_id/new_value)
- [ ] Add formatters: formatProductionEstimate(), formatBomComparison(), formatWhatIf()

**Tests (Claude Code - stdio):**
- [ ] `estimate_production_cost` for a product returns BOM tree with cost estimate
- [ ] Estimate matches actual completed MO's standard cost (same product/qty)
- [ ] `compare_bom_versions` shows component differences and cost delta
- [ ] `what_if_analysis` with component_price override changes only that component's cost
- [ ] `what_if_analysis` with quantity override scales all costs proportionally
- [ ] What-if delta dashboard shows baseline vs scenario clearly

**Tests (claude.ai - HTTP):**
- [ ] All 3 estimation tools appear in tools/list
- [ ] What-if analysis returns readable delta comparison via HTTP

**Success Criteria:**
- Estimation works without existing MO
- BOM comparison highlights differences clearly
- What-if correctly isolates override impact
- All formatters produce three-part output

---

### Stage 11: Trends & Comparison Tools (3 tools)
**Goal:** Historical cost trends and performance comparison
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/tools/trends-tools.ts` — 3 tools:
  1. `get_efficiency_summary` — aggregate mrp.workorder actual vs planned durations by work center (use readGroup). Show utilization %, cost efficiency, over/under time
  2. `compare_mo_performance` — get MO's actual cost, query historical MOs for same product, compute averages. Rank this MO (better/worse/average). Show percentile position
  3. `get_cost_trends` — query completed MOs for product over time, group by granularity (weekly/monthly/quarterly). Calculate per-unit actual cost per period. Show standard vs actual trend lines
- [ ] Add 3 Zod schemas (GetCostTrendsSchema includes granularity enum)
- [ ] Add formatters: formatEfficiencySummary(), formatMOComparison(), formatCostTrends()

**Tests (Claude Code - stdio):**
- [ ] `get_efficiency_summary` shows planned vs actual hours per work center
- [ ] `compare_mo_performance` ranks MO against historical average for same product
- [ ] `get_cost_trends` returns time-series data grouped by selected granularity
- [ ] Monthly and quarterly aggregations produce correct period labels
- [ ] Empty results (new product, no history) handled gracefully

**Tests (claude.ai - HTTP):**
- [ ] All 3 trends tools appear in tools/list
- [ ] Cost trends returns time-series table via HTTP

**Success Criteria:**
- Efficiency summary matches work order duration data
- MO comparison provides meaningful ranking
- Cost trends aggregate correctly by period
- Graceful handling of products with limited history

---

### Stage 12: Final Integration + Registration
**Goal:** Wire all 21 tools together, register in Claude Code, end-to-end validation
**Estimated effort:** Simple

**Tasks:**
- [ ] Update `src/tools/register-all.ts` to import and register all 6 tool files:
  - registerKnowledgeTools (2 tools)
  - registerDiscoveryTools (5 tools)
  - registerCostTools (4 tools)
  - registerVarianceTools (4 tools)
  - registerEstimationTools (3 tools)
  - registerTrendsTools (3 tools)
- [ ] `npm run build` — clean compilation of all 21 tools
- [ ] Register in `.claude/mcp.json`:
  ```json
  "manufacturing-mcp": {
    "command": "node",
    "args": ["C:/Users/KasunJ/mcp/manufacturing-mcp/dist/index.js", "stdio"],
    "env": { "ODOO_URL": "...", "ODOO_DB": "...", "ODOO_USERNAME": "...", "ODOO_PASSWORD": "..." }
  }
  ```
- [ ] Create `CLAUDE.md` for the project with tool descriptions and usage guidance

**Tests (Claude Code - stdio):**
- [ ] All 21 tools listed when server starts
- [ ] Full workflow test: "Search for completed MOs" → pick one → "Show BOM" → "Calculate standard cost" → "Get actual cost" → "Analyze variance"
- [ ] Knowledge tools work independently of Odoo
- [ ] Health check shows all systems green

**Tests (claude.ai - HTTP):**
- [ ] `curl localhost:3001/health` returns all 21 tools in tool list
- [ ] Full workflow via HTTP: search → detail → BOM → cost → variance
- [ ] Deploy to Railway (optional): push to GitHub, Railway auto-deploys

**Success Criteria:**
- All 21 tools registered and callable
- Full cost analysis workflow completes end-to-end
- Three-part output format renders correctly (BOM tree + Variance dashboard + Key findings)
- Multi-audience detail levels (summary/detailed/technical) work across all tools

---

## Dependencies

| Dependency | Required For | Source |
|-----------|-------------|--------|
| Node.js >= 18 | Runtime | Already installed |
| Odoo instance with Manufacturing module | All Odoo queries | DuraCube production Odoo |
| Odoo API key/credentials | Authentication | Existing — same as crm-mcp |
| crm-mcp source code | Reference patterns to copy/adapt | `C:\Users\KasunJ\mcp\crm-mcp` |
| duracube-contract-mcp source | Knowledge encoding patterns | `C:\Users\KasunJ\mcp\customer_contract_review` |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Custom Odoo fields (std_cost, mo_cost, etc.) may have different names | Run `fields_get` on each model during Stage 3 to verify actual field names |
| Deep BOMs cause many API calls (performance) | Batch product reads by collecting all IDs first. Cache aggressively (10-min TTL). |
| Phantom BOM within phantom BOM (infinite recursion) | visitedBomIds set passed as copy to each branch. Max depth limit as safety net. |
| stock.move.value not populated for all costing methods | Fall back to qty * standard_price when value is null/0. Flag as estimate. |
| Work order duration stored in minutes (float) | Consistent division by 60 for hourly cost calculations. Document in cost-methodology.json. |
| Odoo API rate limits or timeouts on large queries | Connection pooling + circuit breaker + retry with exponential backoff (all copied from crm-mcp) |
| BOM cache stale after Odoo changes | 10-minute TTL is conservative. Health check tool can clear cache on demand. |

## Key Design Decisions

1. **No Redis cache** — Single-instance initially. Memory LRU only. Simplifies deployment.
2. **No export/Excel** — Cost analysis tool, not data export. Removes exceljs dependency.
3. **Port 3001** — Avoids conflict with crm-mcp on 3000.
4. **Custom DuraCube fields** — Use pre-calculated fields (std_cost, mo_cost) when available, BOM rollup as fallback.
5. **BOM cache keyed by bomId + quantity** — Different quantities produce different operation costs.
6. **Scrap ÷ GOOD units** — Per-unit actual cost always divides by good units produced.
7. **detail_level parameter** — summary (executives), detailed (managers), technical (accountants). Adapts terminology AND output depth.

## Notes

- The 21 tools follow the crm-mcp naming convention: `search_*` for search, `get_*` for detail/lookup, `calculate_*` for computation, `analyze_*`/`compare_*` for analysis
- All tools are READ-ONLY — no writes to Odoo via XML-RPC
- Tool annotations mark all tools as `readOnlyHint: true, destructiveHint: false, idempotentHint: true`
- The three-part output format (BOM tree + Variance dashboard + Key findings) is the signature format, similar to how duracube-contract-mcp has the departure schedule format
