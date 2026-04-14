/**
 * Output Formatters for Manufacturing MCP
 *
 * Base utility functions adapted from crm-mcp.
 * Tool-specific formatters will be added as tools are built.
 */

import type { DetailLevel } from '../constants.js';

// =============================================================================
// VALUE FORMATTERS
// =============================================================================

/** Format a number as AUD currency */
export function formatCurrency(value: number | undefined | null): string {
  if (value === undefined || value === null || isNaN(value)) return '-';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

/** Format a number as percentage (rounded to integer) */
export function formatPercent(value: number | undefined | null): string {
  if (value === undefined || value === null || isNaN(value)) return '-';
  return `${Math.round(value)}%`;
}

/** Format a date string in en-AU locale */
export function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/** Format minutes as human-readable duration */
export function formatDuration(minutes: number | undefined | null): string {
  if (minutes === undefined || minutes === null || isNaN(minutes)) return '-';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** Extract name from Odoo many2one relation field [id, name] */
export function getRelationName(field: [number, string] | undefined | null): string {
  return field?.[1] || '-';
}

/** Extract ID from Odoo many2one relation field [id, name] */
export function getRelationId(field: [number, string] | undefined | null): number | null {
  return field?.[0] || null;
}

/** Truncate text to max length */
export function truncateText(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// =============================================================================
// VARIANCE FORMATTERS
// =============================================================================

/** Format a cost variance with sign and direction indicator */
export function formatVariance(variance: number): string {
  if (isNaN(variance)) return '-';
  const sign = variance > 0 ? '+' : '';
  return `${sign}${formatCurrency(variance)}`;
}

/** Format variance percentage with direction */
export function formatVariancePercent(percent: number): string {
  if (isNaN(percent)) return '-';
  const sign = percent > 0 ? '+' : '';
  return `${sign}${Math.round(percent * 10) / 10}%`;
}

/** Get variance status label based on threshold */
export function getVarianceStatusLabel(variancePercent: number): string {
  const absPercent = Math.abs(variancePercent);
  if (variancePercent < 0) return 'FAVORABLE';
  if (absPercent <= 5) return 'ON TARGET';
  if (absPercent <= 10) return 'UNFAVORABLE';
  if (absPercent <= 25) return 'SIGNIFICANT';
  return 'CRITICAL';
}

// =============================================================================
// MO STATE FORMATTING
// =============================================================================

const MO_STATE_LABELS: Record<string, string> = {
  'draft': 'Draft',
  'confirmed': 'Confirmed',
  'progress': 'In Progress',
  'to_close': 'To Close',
  'done': 'Done',
  'cancel': 'Cancelled',
};

export function formatMOState(state: string | undefined): string {
  if (!state) return '-';
  return MO_STATE_LABELS[state] || state;
}

// =============================================================================
// PAGINATION FOOTER
// =============================================================================

export function formatPaginationFooter(
  count: number,
  total: number,
  offset: number,
  hasMore: boolean,
  nextOffset?: number
): string {
  let footer = `\n---\n**Showing:** ${offset + 1}-${offset + count} of ${total}`;
  if (hasMore && nextOffset !== undefined) {
    footer += ` | **Next page:** Use offset=${nextOffset}`;
  }
  return footer;
}
