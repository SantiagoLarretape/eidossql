// The visualization step model: what the UI renders and animates.
// Row ids are stable across steps so the UI can animate a row's journey
// (moving, surviving a filter, being dropped) via FLIP transitions.

import type { Value } from './values';
import type { Span } from './ast';

export type RowStatus =
  | 'normal'   // present, nothing special this step
  | 'kept'     // explicitly passed a test this step
  | 'dropped'  // failed a test this step; will be gone next step
  | 'new';     // appeared this step (computed column, null-extended row, group row)

export type ColStatus = 'normal' | 'new' | 'dim';

export interface VizColumn {
  id: string;      // stable key for column animations
  label: string;
  source?: string; // table alias the column came from (shown as a chip)
  status: ColStatus;
}

export interface VizRow {
  id: string;
  status: RowStatus;
  /** categorical color index (group / partition / join-side provenance) */
  group?: number;
  note?: string;
  cells: Value[];
}

export interface VizTable {
  columns: VizColumn[];
  rows: VizRow[];
  /** number of additional rows not shown (display cap) */
  truncated?: number;
}

export type Phase =
  | 'from' | 'join' | 'where' | 'group' | 'having' | 'window'
  | 'select' | 'distinct' | 'setop' | 'orderby' | 'limit'
  | 'cte' | 'subquery' | 'result';

export interface Step {
  id: number;
  phase: Phase;
  /** short label, e.g. "WHERE" — shown on the timeline chip */
  chip: string;
  /** e.g. "WHERE cost_usd > 50000" */
  title: string;
  /** what happened, with real row counts */
  desc: string;
  /** optional teaching callout */
  insight?: string;
  /** SQL region this step corresponds to (highlighted in the editor) */
  span?: Span;
  /** nesting context, e.g. ["CTE acct_orders"] or ["UNION — branch 2"] */
  path: string[];
  /**
   * the tables / CTEs / subqueries feeding this step's relation, each with a
   * stable color slot — drives the timeline chip tinting (a join chip shows
   * both sides half-and-half) and the timeline legend
   */
  sources?: { name: string; color: number }[];
  table: VizTable;
}

/** Cap on rows actually rendered per step (engine always computes all rows). */
export const MAX_VIZ_ROWS = 100;

/** The final-result step shows more rows than intermediate (animated) steps. */
export const MAX_RESULT_ROWS = 1000;
