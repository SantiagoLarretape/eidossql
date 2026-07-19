// The step-emitting SQL executor.
//
// Queries are evaluated in SQL's *logical* clause order —
//   FROM → JOIN → WHERE → GROUP BY → HAVING → window functions → SELECT
//   → DISTINCT → set ops → ORDER BY → LIMIT
// — and a visualization snapshot (Step) is recorded at each stage, with
// stable row ids so the UI can animate each row's journey. CTEs, subqueries,
// and set-operation branches run as nested step groups.

import { parse } from './parser';
import { SqlError } from './tokens';
import type {
  Query, QueryBody, SelectCore, SetOp, TableRef, Join, Expr, ColRef, Call,
  SelectItem, Span, WindowSpec,
} from './ast';
import type { Value } from './values';
import {
  compareValues, orderCompare, groupKey, truthy, isInterval, isDateLike,
  toDate, fromDate, formatValue,
} from './values';
import {
  SCALAR_FUNCS, AGG_FUNC_NAMES, WINDOW_ONLY_FUNCS, computeAggregate,
  extractField, parseIntervalLiteral,
} from './functions';
import type { Dataset } from '../data/datasets';
import type { Step, VizTable, VizColumn, RowStatus } from './steps';
import { MAX_VIZ_ROWS, MAX_RESULT_ROWS } from './steps';

// ---------- relations ----------

interface RelCol {
  id: string;
  name: string;
  source?: string; // table alias
  isInt?: boolean; // integer-typed (for Postgres integer division)
}
interface RelRow {
  id: string;
  vals: Value[];
}
interface Relation {
  cols: RelCol[];
  rows: RelRow[];
  /** display names of the tables/CTEs/subqueries this relation derives from */
  sources: string[];
}

interface TableEntry {
  rel: Relation;
  display: string;
}
interface Env {
  tables: Map<string, TableEntry>;
}

interface GroupCtx {
  keyVals: Value[];
  rows: RelRow[];
  aggCache: Map<string, Value>;
}

interface Ctx {
  cols: RelCol[];
  row?: RelRow;
  group?: GroupCtx;
  /** normalized SQL of each GROUP BY key */
  keySqls?: string[];
  /** column indexes that are group keys (for resolving qualified/aliased refs) */
  keyColIdx?: Map<number, number>; // col index -> key position
  env: Env;
  aliases?: { name: string; expr: Expr }[];
  windowVals?: Map<Call, Map<string, Value>>;
  clause: string;
  path: string[];
}

interface OuterFrame {
  ctx: Ctx;
  used: { hit: boolean };
}

export interface RunResult {
  steps: Step[];
  result: VizTable;
}

export function runQuery(sql: string, dataset: Dataset): RunResult {
  const q = parse(sql);
  const ex = new Executor(sql, dataset);
  return ex.run(q);
}

let colIdCounter = 0;
function freshColId(name: string): string {
  return `${name}#${++colIdCounter}`;
}

class Executor {
  sql: string;
  steps: Step[] = [];
  stepId = 0;
  silentDepth = 0;
  rootEnv: Env;
  outerStack: OuterFrame[] = [];
  subqCache = new Map<Query, Relation>();
  subqSeen = new Set<Query>();
  intTypeMemo = new Map<Expr, boolean>();
  inSetCache = new Map<Query, { set: Set<string>; hasNull: boolean }>();
  /** work meter — aborts runaway queries instead of freezing the tab */
  work = 0;
  /** stable color slot per source entity (table / CTE / subquery alias) */
  sourceColors = new Map<string, number>();

  constructor(sql: string, dataset: Dataset) {
    this.sql = sql;
    const tables = new Map<string, TableEntry>();
    for (const t of dataset.tables) {
      const cols: RelCol[] = t.columns.map((c) => ({
        id: freshColId(c.name),
        name: c.name,
        isInt: c.type === 'integer',
      }));
      const rows: RelRow[] = t.rows.map((r, i) => ({ id: `${t.name}:${i}`, vals: r as Value[] }));
      tables.set(t.name.toLowerCase(), { rel: { cols, rows, sources: [t.name] }, display: t.name });
    }
    this.rootEnv = { tables };
  }

  run(q: Query): RunResult {
    const rel = this.execQuery(q, this.rootEnv, [], true);
    return { steps: this.steps, result: this.plainViz(rel) };
  }

  // ---------- step helpers ----------

  text(sp: Span): string {
    return this.sql.slice(sp.start, sp.end);
  }
  short(s: string, n = 48): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  norm(e: Span): string {
    return this.text(e).toLowerCase().replace(/\s+/g, '');
  }

  pushStep(s: Omit<Step, 'id'>): void {
    if (this.silentDepth > 0) return;
    this.steps.push({ ...s, id: this.stepId++ });
  }

  colorOf(name: string): number {
    const key = name.toLowerCase();
    let c = this.sourceColors.get(key);
    if (c === undefined) {
      c = this.sourceColors.size % 8;
      this.sourceColors.set(key, c);
    }
    return c;
  }

  /** color-tagged sources for a step (dedupes, preserves first-seen order) */
  tag(sources: string[]): { name: string; color: number }[] {
    const seen = new Set<string>();
    const out: { name: string; color: number }[] = [];
    for (const s of sources) {
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: s, color: this.colorOf(s) });
    }
    return out;
  }

  tick(n = 1): void {
    this.work += n;
    if (this.work > 30_000_000) {
      throw new SqlError(
        'This query needs more computation than the visualizer can handle',
        0, this.sql.length,
        'Usually that means a huge join or a subquery re-evaluated for every row. Load a smaller row sample, or narrow the tables (e.g. in a CTE) before combining them.',
      );
    }
  }

  vizCols(rel: Relation, status?: Map<string, VizColumn['status']>): VizColumn[] {
    return rel.cols.map((c) => ({
      id: c.id,
      label: c.name,
      source: c.source,
      status: status?.get(c.id) ?? 'normal',
    }));
  }

  viz(
    rel: Relation,
    opts: {
      rowStatus?: Map<string, RowStatus>;
      groups?: Map<string, number>;
      notes?: Map<string, string>;
      colStatus?: Map<string, VizColumn['status']>;
      order?: RelRow[];
      cap?: number;
    } = {},
  ): VizTable {
    const cap = opts.cap ?? MAX_VIZ_ROWS;
    const rows = opts.order ?? rel.rows;
    const shown = rows.slice(0, cap);
    return {
      columns: this.vizCols(rel, opts.colStatus),
      rows: shown.map((r) => ({
        id: r.id,
        status: opts.rowStatus?.get(r.id) ?? 'normal',
        group: opts.groups?.get(r.id),
        note: opts.notes?.get(r.id),
        cells: r.vals,
      })),
      truncated: rows.length > cap ? rows.length - cap : undefined,
    };
  }

  plainViz(rel: Relation, cap?: number): VizTable {
    return this.viz(rel, { cap });
  }

  // ---------- query execution ----------

  execQuery(q: Query, env: Env, path: string[], outermost = false): Relation {
    const env2: Env = { tables: new Map(env.tables) };
    for (const cte of q.ctes) {
      const rel = this.execQuery(cte.query, env2, [...path, `WITH ${cte.name}`]);
      env2.tables.set(cte.name.toLowerCase(), { rel, display: cte.name });
      this.pushStep({
        phase: 'cte',
        chip: 'CTE',
        title: `CTE "${cte.name}" is ready`,
        desc: `The WITH clause ran first and produced a temporary table called ${cte.name} with ${rel.rows.length} row${plural(rel.rows.length)}. The rest of the query can use it like any other table.`,
        span: { start: cte.start, end: cte.end },
        path,
        sources: this.tag([cte.name]),
        table: this.plainViz(rel),
      });
    }

    let rel: Relation;
    if (q.body.kind === 'select') {
      rel = this.execSelect(q.body, env2, path, q);
    } else if (q.body.kind === 'setop') {
      rel = this.execSetOp(q.body, env2, path);
      rel = this.applyTailOnOutput(rel, q, path);
    } else {
      rel = this.execQuery(q.body, env2, path);
      rel = this.applyTailOnOutput(rel, q, path);
    }

    if (outermost) {
      this.pushStep({
        phase: 'result',
        chip: 'RESULT',
        title: `Final result — ${rel.rows.length.toLocaleString()} row${plural(rel.rows.length)}`,
        desc: `This is the table the database returns for the query.`,
        span: { start: q.start, end: q.end },
        path,
        sources: this.tag(rel.sources),
        table: this.plainViz(rel, MAX_RESULT_ROWS),
      });
    }
    return rel;
  }

  // ---------- FROM / JOIN ----------

  resolveTableRef(ref: TableRef, env: Env, path: string[]): { rel: Relation; alias: string; display: string } {
    if (ref.kind === 'subqueryTable') {
      const sub = this.execQuery(ref.query, env, [...path, `Subquery "${ref.alias}"`]);
      const cols = sub.cols.map((c) => ({ ...c, id: freshColId(c.name), source: ref.alias }));
      const rows = sub.rows.map((r, i) => ({ id: `${ref.alias}:${i}`, vals: r.vals }));
      return { rel: { cols, rows, sources: [ref.alias] }, alias: ref.alias, display: `subquery "${ref.alias}"` };
    }
    const entry = env.tables.get(ref.name.toLowerCase());
    if (!entry) {
      const names = [...env.tables.values()].map((t) => t.display).join(', ');
      throw new SqlError(
        `Table "${ref.name}" does not exist in this dataset`,
        ref.start, ref.end,
        `Available tables: ${names}.`,
      );
    }
    const alias = ref.alias ?? entry.display;
    const cols = entry.rel.cols.map((c) => ({ ...c, id: freshColId(c.name), source: alias }));
    const rows = entry.rel.rows.map((r) => ({ id: `${alias}:${r.id}`, vals: r.vals }));
    return { rel: { cols, rows, sources: [entry.display] }, alias, display: entry.display };
  }

  execJoin(left: Relation, join: Join, env: Env, path: string[]): Relation {
    const { rel: right, alias } = this.resolveTableRef(join.table, env, path);
    for (const lc of left.cols) {
      if (lc.source && lc.source.toLowerCase() === alias.toLowerCase()) {
        throw new SqlError(
          `Table name "${alias}" is used more than once`,
          join.table.start, join.table.end,
          'Give the second occurrence a different alias, e.g. FROM accounts a1 JOIN accounts a2 ON ...',
        );
      }
    }
    const cols = [...left.cols, ...right.cols];
    let onExpr = join.on;
    if (join.using) {
      // treat USING (a, b) as ON l.a = r.a AND l.b = r.b
      let e: Expr | undefined;
      for (const name of join.using) {
        const lcol = left.cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
        const rcol = right.cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (!lcol || !rcol) {
          throw new SqlError(`Column "${name}" in USING must exist on both sides of the join`, join.start, join.end);
        }
        const eq: Expr = {
          kind: 'binary', op: '=',
          left: { kind: 'col', table: lcol.source, name, start: join.start, end: join.end },
          right: { kind: 'col', table: alias, name, start: join.start, end: join.end },
          start: join.start, end: join.end,
        };
        e = e ? { kind: 'binary', op: 'and', left: e, right: eq, start: join.start, end: join.end } : eq;
      }
      onExpr = e;
    }
    if (onExpr && this.containsAgg(onExpr)) {
      throw new SqlError('Aggregate functions are not allowed in a JOIN condition', onExpr.start, onExpr.end);
    }

    // --- join planning ------------------------------------------------------
    // Equality conditions (the overwhelmingly common case) get a hash join, so
    // full-size tables join in linear time like a real database. Anything the
    // planner can't split cleanly stays a per-pair "residual" test; joins with
    // no usable equality fall back to the nested-loop path.
    const conjuncts: Expr[] = [];
    const flattenAnd = (e: Expr): void => {
      if (e.kind === 'binary' && e.op === 'and') {
        flattenAnd(e.left);
        flattenAnd(e.right);
      } else conjuncts.push(e);
    };
    if (onExpr) flattenAnd(onExpr);

    const sideOf = (e: Expr): 'left' | 'right' | 'both' | 'none' | 'bail' => {
      let inL = false;
      let inR = false;
      let bail = false;
      this.walk(e, (x) => {
        if (x.kind === 'subquery' || x.kind === 'exists' || (x.kind === 'in' && x.query)) bail = true;
        if (x.kind === 'call' && (x.over || AGG_FUNC_NAMES.has(x.name))) bail = true;
        if (x.kind === 'col') {
          let l = false;
          let r = false;
          try { l = this.findColIndex(x, left.cols) !== null; } catch { bail = true; }
          try { r = this.findColIndex(x, right.cols) !== null; } catch { bail = true; }
          if (l && r) bail = true; // ambiguous — let normal evaluation report it
          else if (l) inL = true;
          else if (r) inR = true;
          else bail = true; // unknown column — normal evaluation raises the error
        }
      });
      if (bail) return 'bail';
      if (inL && inR) return 'both';
      if (inL) return 'left';
      if (inR) return 'right';
      return 'none';
    };

    const equiL: Expr[] = [];
    const equiR: Expr[] = [];
    const residual: Expr[] = [];
    for (const c of conjuncts) {
      if (c.kind === 'binary' && c.op === '=') {
        const ls = sideOf(c.left);
        const rs = sideOf(c.right);
        if ((ls === 'left' || ls === 'none') && (rs === 'right' || rs === 'none')) {
          equiL.push(c.left);
          equiR.push(c.right);
          continue;
        }
        if ((ls === 'right' || ls === 'none') && (rs === 'left' || rs === 'none')) {
          equiL.push(c.right);
          equiR.push(c.left);
          continue;
        }
      }
      residual.push(c);
    }
    const useHash = equiL.length > 0;

    const pairCount = left.rows.length * right.rows.length;
    if (!useHash && pairCount > 1_500_000) {
      throw new SqlError(
        `This join has no equality condition to match on, so it would test ${pairCount.toLocaleString()} row combinations (${left.rows.length.toLocaleString()} × ${right.rows.length.toLocaleString()}) — too many to visualize`,
        join.start, join.end,
        'Add an ON equality (e.g. ON a.id = b.account_id), or narrow the tables first (e.g. filter in a CTE).',
      );
    }

    let buckets: Map<string, RelRow[]> | null = null;
    if (useHash) {
      buckets = new Map();
      for (const r of right.rows) {
        this.tick();
        const ctx: Ctx = { cols: right.cols, row: r, env, clause: 'ON', path };
        const keys = equiR.map((e) => this.evalExpr(e, ctx));
        if (keys.some((k) => k === null)) continue; // NULL never equals anything
        const k = groupKey(keys);
        let b = buckets.get(k);
        if (!b) {
          b = [];
          buckets.set(k, b);
        }
        b.push(r);
      }
    }

    const type = join.type;
    const nullsR = right.cols.map(() => null as Value);
    const nullsL = left.cols.map(() => null as Value);
    const resultRows: RelRow[] = [];
    const vizRows: RelRow[] = [];
    const rowStatus = new Map<string, RowStatus>();
    const notes = new Map<string, string>();
    const groups = new Map<string, number>();
    const rightMatched = new Set<string>();
    let matchCount = 0;
    let unmatchedLeft = 0;

    left.rows.forEach((l, li) => {
      let candidates: RelRow[];
      if (buckets) {
        const ctx: Ctx = { cols: left.cols, row: l, env, clause: 'ON', path };
        const keys = equiL.map((e) => this.evalExpr(e, ctx));
        candidates = keys.some((k) => k === null) ? [] : buckets.get(groupKey(keys)) ?? [];
      } else {
        candidates = right.rows;
      }
      let any = false;
      for (const r of candidates) {
        this.tick();
        let ok = true;
        if (buckets) {
          if (residual.length) {
            const ctx: Ctx = { cols, row: { id: '', vals: [...l.vals, ...r.vals] }, env, clause: 'ON', path };
            ok = residual.every((e) => truthy(this.evalExpr(e, ctx)));
          }
        } else if (onExpr) {
          const ctx: Ctx = { cols, row: { id: '', vals: [...l.vals, ...r.vals] }, env, clause: 'ON', path };
          ok = truthy(this.evalExpr(onExpr, ctx));
        }
        if (ok) {
          any = true;
          matchCount++;
          rightMatched.add(r.id);
          const row = { id: `${l.id}⋈${r.id}`, vals: [...l.vals, ...r.vals] };
          resultRows.push(row);
          vizRows.push(row);
          groups.set(row.id, li);
          if (resultRows.length > 500_000) {
            throw new SqlError(
              'This join produces more than 500,000 rows — too many to visualize',
              join.start, join.end,
              'The ON condition matches very broadly. Check the join keys, or narrow the tables before joining.',
            );
          }
        }
      }
      if (!any) {
        unmatchedLeft++;
        const ghost = { id: `${l.id}⋈∅`, vals: [...l.vals, ...nullsR] };
        vizRows.push(ghost);
        groups.set(ghost.id, li);
        if (type === 'left' || type === 'full') {
          resultRows.push(ghost);
          rowStatus.set(ghost.id, 'new');
          notes.set(ghost.id, 'no match — kept, filled with NULLs');
        } else if (type === 'inner') {
          rowStatus.set(ghost.id, 'dropped');
          notes.set(ghost.id, 'no match — removed by INNER JOIN');
        } else {
          rowStatus.set(ghost.id, 'dropped');
          notes.set(ghost.id, 'no match on the left side');
        }
      }
    });

    let unmatchedRight = 0;
    if (type === 'right' || type === 'full') {
      for (const r of right.rows) {
        if (!rightMatched.has(r.id)) {
          unmatchedRight++;
          const ghost = { id: `∅⋈${r.id}`, vals: [...nullsL, ...r.vals] };
          resultRows.push(ghost);
          vizRows.push(ghost);
          rowStatus.set(ghost.id, 'new');
          notes.set(ghost.id, 'no match — kept, filled with NULLs');
        }
      }
    } else if (type === 'inner' || type === 'left') {
      unmatchedRight = right.rows.filter((r) => !rightMatched.has(r.id)).length;
    }

    const rel: Relation = { cols, rows: resultRows, sources: [...left.sources, ...right.sources] };
    const typeName = type === 'inner' ? 'JOIN' : `${type.toUpperCase()} JOIN`;
    const descParts: string[] = [];
    if (type === 'cross') {
      descParts.push(
        `Every one of the ${left.rows.length} rows pairs with every one of the ${right.rows.length} rows in ${alias} — ${resultRows.length} combinations.`,
      );
    } else {
      descParts.push(
        `Each row is matched against ${alias} using the ON condition: ${matchCount} matching combination${plural(matchCount)}.`,
      );
      if (unmatchedLeft > 0) {
        if (type === 'left' || type === 'full') {
          descParts.push(`${unmatchedLeft} row${plural(unmatchedLeft)} had no match and ${unmatchedLeft === 1 ? 'is' : 'are'} kept with NULLs for the ${alias} columns.`);
        } else {
          descParts.push(`${unmatchedLeft} row${plural(unmatchedLeft)} had no match and ${unmatchedLeft === 1 ? 'is' : 'are'} removed.`);
        }
      }
      if (unmatchedRight > 0) {
        if (type === 'right' || type === 'full') {
          descParts.push(`${unmatchedRight} ${alias} row${plural(unmatchedRight)} had no match and ${unmatchedRight === 1 ? 'is' : 'are'} kept with NULLs.`);
        } else {
          descParts.push(`(${unmatchedRight} ${alias} row${plural(unmatchedRight)} never matched and simply never appear${unmatchedRight === 1 ? 's' : ''}.)`);
        }
      }
    }
    const insights: Record<string, string> = {
      inner: 'INNER JOIN keeps only rows that find a partner in both tables.',
      left: 'LEFT JOIN keeps every row of the left (first) table — match or not. Missing right-side values become NULL.',
      right: 'RIGHT JOIN keeps every row of the right (second) table — match or not. Missing left-side values become NULL.',
      full: 'FULL JOIN keeps every row from both sides, filling NULLs wherever there is no match.',
      cross: 'A cross join has no ON condition, so you get every possible pairing. Usually a sign a JOIN condition is missing!',
    };
    this.pushStep({
      phase: 'join',
      chip: typeName,
      title: this.short(`${typeName} ${this.text({ start: join.table.start, end: join.end })}`, 70),
      desc: descParts.join(' '),
      insight: insights[type],
      span: { start: join.start, end: join.end },
      path,
      sources: this.tag(rel.sources),
      table: this.viz({ cols, rows: vizRows, sources: rel.sources }, { rowStatus, notes, groups }),
    });
    return rel;
  }

  // ---------- main SELECT pipeline ----------

  execSelect(sc: SelectCore, env: Env, path: string[], tail?: Query): Relation {
    // FROM
    let rel: Relation;
    if (sc.from) {
      const { rel: base, alias, display } = this.resolveTableRef(sc.from.base, env, path);
      rel = base;
      this.pushStep({
        phase: 'from',
        chip: 'FROM',
        title: `FROM ${display}${alias !== display ? ` (as "${alias}")` : ''}`,
        desc: `Start with the full ${display} table — all ${rel.rows.length} row${plural(rel.rows.length)}, all ${rel.cols.length} columns. Nothing is filtered yet.`,
        insight: sc.from.base.kind === 'table' && sc.from.base.alias
          ? `The alias "${alias}" is just a nickname — the rest of the query uses it to refer to this table.`
          : undefined,
        span: sc.fromSpan,
        path,
        sources: this.tag(rel.sources),
        table: this.plainViz(rel),
      });
      for (const j of sc.from.joins) {
        rel = this.execJoin(rel, j, env, path);
      }
    } else {
      rel = { cols: [], rows: [{ id: 'r0', vals: [] }], sources: [] };
    }

    const baseCtx = (row: RelRow): Ctx => ({
      cols: rel.cols, row, env, clause: 'WHERE',
      aliases: this.selectAliases(sc), path,
    });

    // WHERE
    if (sc.where) {
      if (this.containsAgg(sc.where)) {
        throw new SqlError(
          'Aggregate functions are not allowed in WHERE', sc.where.start, sc.where.end,
          'WHERE filters individual rows before any grouping happens. To filter on an aggregate like COUNT or SUM, use HAVING after GROUP BY.',
        );
      }
      if (this.containsWindow(sc.where)) {
        throw new SqlError(
          'Window functions are not allowed in WHERE', sc.where.start, sc.where.end,
          'Window functions are computed near the end of the query. To filter on one, compute it in a subquery or CTE first, then filter the result.',
        );
      }
      const rowStatus = new Map<string, RowStatus>();
      const kept: RelRow[] = [];
      for (const row of rel.rows) {
        this.tick();
        const pass = truthy(this.evalExpr(sc.where, { ...baseCtx(row), clause: 'WHERE' }));
        rowStatus.set(row.id, pass ? 'kept' : 'dropped');
        if (pass) kept.push(row);
      }
      const dropped = rel.rows.length - kept.length;
      this.pushStep({
        phase: 'where',
        chip: 'WHERE',
        title: this.short(`WHERE ${this.text(sc.where)}`, 70),
        desc: `Every row is tested, one at a time. ${kept.length} of ${rel.rows.length} row${plural(rel.rows.length)} pass${kept.length === 1 ? 'es' : ''}; ${dropped} ${dropped === 1 ? 'is' : 'are'} removed.`,
        insight: 'WHERE sees the raw rows — it runs before GROUP BY and before SELECT, which is why it can\'t use column aliases or aggregates.',
        span: sc.whereSpan,
        path,
        sources: this.tag(rel.sources),
        table: this.viz(rel, { rowStatus }),
      });
      rel = { cols: rel.cols, rows: kept, sources: rel.sources };
    }

    // Decide on grouping
    const tailOrderExprs = tail?.orderBy?.map((o) => o.expr) ?? [];
    const anyAgg =
      sc.items.some((it) => this.containsAgg(it.expr)) ||
      (sc.having ? this.containsAgg(sc.having) : false) ||
      tailOrderExprs.some((e) => this.containsAgg(e));
    const grouped = !!sc.groupBy || !!sc.having || anyAgg;

    let groupCtxOf: ((row: RelRow) => Ctx) | null = null;
    let preGroupRel: Relation | null = null;

    if (grouped) {
      preGroupRel = rel;
      const keyExprs: Expr[] = [];
      const keyLabels: string[] = [];
      if (sc.groupBy) {
        for (const g of sc.groupBy) {
          const resolved = this.resolveGroupExpr(g, sc, rel);
          keyExprs.push(resolved.expr);
          keyLabels.push(resolved.label);
        }
      }
      const keySqls = keyExprs.map((e) => this.norm(e));
      const keyColIdx = new Map<number, number>();
      keyExprs.forEach((e, ki) => {
        if (e.kind === 'col') {
          const idx = this.findColIndex(e, rel.cols);
          if (idx !== null) keyColIdx.set(idx, ki);
        }
      });

      // build groups (in order of first appearance)
      const groupsMap = new Map<string, GroupCtx>();
      for (const row of rel.rows) {
        this.tick();
        const ctx: Ctx = { cols: rel.cols, row, env, clause: 'GROUP BY', path };
        const keyVals = keyExprs.map((e) => this.evalExpr(e, ctx));
        const k = groupKey(keyVals);
        let g = groupsMap.get(k);
        if (!g) {
          g = { keyVals, rows: [], aggCache: new Map() };
          groupsMap.set(k, g);
        }
        g.rows.push(row);
      }
      // SQL quirk: an aggregate with no GROUP BY over zero rows still
      // produces one row (count(*) = 0, sum = NULL, ...)
      if (!sc.groupBy && groupsMap.size === 0) {
        groupsMap.set(groupKey([]), { keyVals: [], rows: [], aggCache: new Map() });
      }
      const groupList = [...groupsMap.entries()];

      if (sc.groupBy) {
        // Step A: color rows by group (reordered so groups are contiguous)
        const order: RelRow[] = [];
        const colorOf = new Map<string, number>();
        groupList.forEach(([, g], gi) => {
          for (const r of g.rows) {
            order.push(r);
            colorOf.set(r.id, gi);
          }
        });
        this.pushStep({
          phase: 'group',
          chip: 'GROUP BY',
          title: this.short(`GROUP BY ${sc.groupBy.map((g) => this.short(this.text(g), 24)).join(', ')}`, 70),
          desc: `Rows with the same value of (${keyLabels.join(', ')}) are gathered into groups — ${rel.rows.length} row${plural(rel.rows.length)} form ${groupList.length} group${plural(groupList.length)} (one color each).`,
          insight: 'From here on, the query works with whole groups, not individual rows. Each group will become exactly one output row.',
          span: sc.groupSpan,
          path,
          sources: this.tag(rel.sources),
          table: this.viz(rel, { order, groups: colorOf }),
        });
      }

      // collect aggregates needed anywhere downstream
      const aggCalls: Call[] = [];
      const seen = new Set<string>();
      const collect = (e: Expr) => this.collectAggCalls(e, aggCalls, seen);
      sc.items.forEach((it) => collect(it.expr));
      if (sc.having) collect(sc.having);
      tailOrderExprs.forEach(collect);

      // grouped relation: key columns + aggregate columns
      const keyCols: RelCol[] = keyExprs.map((e, i) => ({
        id: freshColId(keyLabels[i]),
        name: keyLabels[i],
        isInt: this.isIntExpr(e, rel.cols),
      }));
      const aggCols: RelCol[] = aggCalls.map((c) => ({
        id: freshColId(this.aggLabel(c, sc)),
        name: this.aggLabel(c, sc),
        isInt: this.isIntExpr(c, rel.cols),
      }));

      const groupedRows: RelRow[] = [];
      const rowGroups = new Map<string, GroupCtx>();
      const colorOf = new Map<string, number>();
      groupList.forEach(([k, g], gi) => {
        const aggVals = aggCalls.map((call) =>
          this.computeAggForGroup(call, g, { cols: rel.cols, env, clause: 'aggregate', path }),
        );
        const row: RelRow = { id: `g:${k}`, vals: [...g.keyVals, ...aggVals] };
        groupedRows.push(row);
        rowGroups.set(row.id, g);
        colorOf.set(row.id, gi);
      });

      const groupedRel: Relation = { cols: [...keyCols, ...aggCols], rows: groupedRows, sources: rel.sources };
      const aggDesc = aggCalls.length
        ? ` Aggregates (${aggCalls.map((c) => this.short(this.text(c), 26)).join(', ')}) are computed across each group's rows.`
        : '';
      this.pushStep({
        phase: 'group',
        chip: sc.groupBy ? 'COLLAPSE' : 'AGGREGATE',
        title: sc.groupBy
          ? `Each group collapses to a single row`
          : `All ${preGroupRel.rows.length} rows aggregate into one`,
        desc: sc.groupBy
          ? `${groupList.length} group${plural(groupList.length)} become${groupList.length === 1 ? 's' : ''} ${groupList.length} row${plural(groupList.length)}.${aggDesc}`
          : `With an aggregate but no GROUP BY, the whole table is one big group producing one row.${aggDesc}`,
        span: sc.groupSpan ?? sc.selectSpan,
        path,
        sources: this.tag(groupedRel.sources),
        table: this.viz(groupedRel, {
          groups: colorOf,
          rowStatus: new Map(groupedRows.map((r) => [r.id, 'new' as RowStatus])),
        }),
      });

      const outerCols = rel.cols;
      rel = groupedRel;
      groupCtxOf = (row: RelRow): Ctx => ({
        cols: outerCols,
        group: rowGroups.get(row.id)!,
        keySqls,
        keyColIdx,
        env,
        aliases: this.selectAliases(sc),
        clause: 'HAVING',
        path,
        row, // the group row itself (its id keys window-value lookups)
      });
    }

    const ctxFor = (row: RelRow): Ctx =>
      groupCtxOf ? groupCtxOf(row) : baseCtx(row);

    // HAVING
    if (sc.having) {
      if (this.containsWindow(sc.having)) {
        throw new SqlError('Window functions are not allowed in HAVING', sc.having.start, sc.having.end,
          'Compute the window value in a subquery or CTE, then filter its result.');
      }
      const rowStatus = new Map<string, RowStatus>();
      const kept: RelRow[] = [];
      for (const row of rel.rows) {
        const pass = truthy(this.evalExpr(sc.having, { ...ctxFor(row), clause: 'HAVING' }));
        rowStatus.set(row.id, pass ? 'kept' : 'dropped');
        if (pass) kept.push(row);
      }
      this.pushStep({
        phase: 'having',
        chip: 'HAVING',
        title: this.short(`HAVING ${this.text(sc.having)}`, 70),
        desc: `HAVING filters whole groups the way WHERE filters rows. ${kept.length} of ${rel.rows.length} group${plural(rel.rows.length)} pass${kept.length === 1 ? 'es' : ''}.`,
        insight: 'WHERE filters rows before grouping; HAVING filters groups after. That\'s why HAVING may use aggregates and WHERE may not.',
        span: sc.havingSpan,
        path,
        sources: this.tag(rel.sources),
        table: this.viz(rel, { rowStatus }),
      });
      rel = { cols: rel.cols, rows: kept, sources: rel.sources };
    }

    // window functions
    const windowCalls: Call[] = [];
    sc.items.forEach((it) => this.collectWindowCalls(it.expr, windowCalls));
    tailOrderExprs.forEach((e) => this.collectWindowCalls(e, windowCalls));
    let windowVals: Map<Call, Map<string, Value>> | undefined;
    let preWindowColCount = rel.cols.length;

    if (windowCalls.length > 0) {
      windowVals = new Map();
      const partitionColor = new Map<string, number>();
      let displayOrder: RelRow[] = rel.rows;
      windowCalls.forEach((call, wi) => {
        const { values, partitions, ordered } = this.computeWindow(call, rel, ctxFor);
        windowVals!.set(call, values);
        if (wi === 0) {
          displayOrder = ordered;
          partitions.forEach((pi, rowId) => partitionColor.set(rowId, pi));
        }
      });
      // append window columns to the relation
      const newCols: RelCol[] = windowCalls.map((c) => ({
        id: freshColId(this.windowLabel(c, sc)),
        name: this.windowLabel(c, sc),
        isInt: this.isIntExpr(c, rel.cols),
      }));
      const newRows = rel.rows.map((r) => ({
        id: r.id,
        vals: [...r.vals, ...windowCalls.map((c) => windowVals!.get(c)!.get(r.id) ?? null)],
      }));
      // keep rows in partition/order-by order (mirrors typical Postgres output
      // and makes values like LAG visually traceable)
      const byId = new Map(newRows.map((r) => [r.id, r]));
      const seenIds = new Set(displayOrder.map((r) => r.id));
      const orderedRows = [
        ...displayOrder.map((r) => byId.get(r.id)!),
        ...newRows.filter((r) => !seenIds.has(r.id)),
      ];
      rel = { cols: [...rel.cols, ...newCols], rows: orderedRows, sources: rel.sources };
      const first = windowCalls[0];
      const spec = first.over!;
      const parts: string[] = [];
      if (spec.partitionBy.length) {
        parts.push(`rows are split into partitions by ${spec.partitionBy.map((p) => this.short(this.text(p), 24)).join(', ')} (one color each)`);
      } else {
        parts.push('the whole table acts as one partition');
      }
      if (spec.orderBy.length) {
        parts.push(`ordered within each partition by ${spec.orderBy.map((o) => this.short(this.text(o), 24)).join(', ')}`);
      }
      const colStatus = new Map(newCols.map((c) => [c.id, 'new' as const]));
      this.pushStep({
        phase: 'window',
        chip: 'WINDOW',
        title: this.short(`Window: ${windowCalls.map((c) => this.short(this.text(c), 34)).join(', ')}`, 78),
        desc: `Unlike GROUP BY, a window function does not collapse rows — ${parts.join(', ')}, and each row gets its computed value in a new column.`,
        insight: 'OVER (...) means: look at related rows ("the window") while keeping every row. PARTITION BY is like a GROUP BY that doesn\'t collapse.',
        span: { start: first.start, end: first.end },
        path,
        sources: this.tag(rel.sources),
        table: this.viz(rel, { groups: partitionColor, colStatus }),
      });
    }

    // SELECT projection
    const outItems = this.expandStars(sc, rel, preWindowColCount, groupCtxOf !== null);
    const outCols: RelCol[] = [];
    const carried = new Set<string>();
    outItems.forEach((it) => {
      const label = it.label;
      let carriedCol: RelCol | undefined;
      if (it.expr.kind === 'col') {
        const idx = this.findColIndex(it.expr as ColRef, rel.cols);
        if (idx !== null) carriedCol = rel.cols[idx];
      }
      if (carriedCol && !carried.has(carriedCol.id) && (!it.alias || it.alias.toLowerCase() === carriedCol.name.toLowerCase())) {
        carried.add(carriedCol.id);
        outCols.push({ ...carriedCol, name: label });
      } else {
        outCols.push({ id: freshColId(label), name: label, source: undefined, isInt: this.isIntExpr(it.expr, rel.cols) });
      }
    });

    const outRows: RelRow[] = rel.rows.map((row) => {
      this.tick();
      const ctx = ctxFor(row);
      ctx.windowVals = windowVals;
      ctx.clause = 'SELECT';
      const vals = outItems.map((it) => {
        if (it.expr.kind === 'col') {
          const idx = this.findColIndex(it.expr as ColRef, rel.cols);
          if (idx !== null && !groupCtxOf) return row.vals[idx];
          if (idx !== null && groupCtxOf) return row.vals[idx];
        }
        return this.evalExpr(it.expr, ctx);
      });
      return { id: row.id, vals };
    });

    const computed = outCols.filter((c) => !carried.has(c.id)).length;
    const droppedCols = rel.cols.slice(0, preWindowColCount).filter((c) => !carried.has(c.id)).length;
    const colStatus = new Map<string, VizColumn['status']>();
    outCols.forEach((c) => {
      if (!carried.has(c.id)) colStatus.set(c.id, 'new');
    });
    let outRel: Relation = { cols: outCols, rows: outRows, sources: rel.sources };
    this.pushStep({
      phase: 'select',
      chip: 'SELECT',
      title: this.short(`SELECT ${sc.items.map((i) => this.short(this.text(i), 26)).join(', ')}`, 78),
      desc:
        `Only now are the output columns chosen: ${outCols.length} column${plural(outCols.length)} ` +
        `(${outCols.length - computed} carried over${computed ? `, ${computed} computed` : ''}` +
        `${droppedCols > 0 ? `; ${droppedCols} column${plural(droppedCols)} not selected disappear${droppedCols === 1 ? 's' : ''}` : ''}).`,
      insight: 'SELECT runs near the end — after FROM, WHERE, and GROUP BY. The column list is a final "what do I want to see" projection.',
      span: sc.selectSpan,
      path,
      sources: this.tag(outRel.sources),
      table: this.viz(outRel, { colStatus }),
    });

    // DISTINCT
    if (sc.distinct) {
      const seenKeys = new Map<string, string>();
      const rowStatus = new Map<string, RowStatus>();
      const notes = new Map<string, string>();
      const kept: RelRow[] = [];
      for (const row of outRel.rows) {
        const k = groupKey(row.vals);
        if (seenKeys.has(k)) {
          rowStatus.set(row.id, 'dropped');
          notes.set(row.id, 'duplicate — already seen above');
        } else {
          seenKeys.set(k, row.id);
          kept.push(row);
        }
      }
      const dropped = outRel.rows.length - kept.length;
      this.pushStep({
        phase: 'distinct',
        chip: 'DISTINCT',
        title: 'DISTINCT — remove duplicate rows',
        desc: dropped > 0
          ? `${dropped} duplicate row${plural(dropped)} removed; ${kept.length} unique row${plural(kept.length)} remain.`
          : 'All rows were already unique — DISTINCT removes nothing.',
        insight: 'DISTINCT compares entire output rows (every selected column together), not just one column.',
        span: sc.selectSpan,
        path,
        sources: this.tag(outRel.sources),
        table: this.viz(outRel, { rowStatus, notes }),
      });
      outRel = { cols: outRel.cols, rows: kept, sources: outRel.sources };
    }

    // ORDER BY / LIMIT (tail of this query level)
    if (tail && (tail.orderBy || tail.limit !== undefined || tail.offset !== undefined)) {
      const preRowById = new Map(rel.rows.map((r) => [r.id, r]));
      outRel = this.applyOrderBy(outRel, tail, path, (rowId, e) => {
        // fall back to evaluating over the pre-projection relation
        const pre = preRowById.get(rowId);
        if (!pre) return null;
        if (sc.distinct) {
          throw new SqlError(
            'With SELECT DISTINCT, ORDER BY expressions must appear in the select list',
            e.start, e.end,
            'Once duplicates are merged, SQL can no longer see non-selected columns. Add the expression to SELECT, or drop DISTINCT.',
          );
        }
        const ctx = ctxFor(pre);
        ctx.windowVals = windowVals;
        ctx.clause = 'ORDER BY';
        return this.evalExpr(e, ctx);
      });
      outRel = this.applyLimit(outRel, tail, path);
    }
    return outRel;
  }

  selectAliases(sc: SelectCore): { name: string; expr: Expr }[] {
    return sc.items
      .filter((it) => it.alias)
      .map((it) => ({ name: it.alias!, expr: it.expr }));
  }

  resolveGroupExpr(g: Expr, sc: SelectCore, rel: Relation): { expr: Expr; label: string } {
    // ordinal: GROUP BY 2
    if (g.kind === 'num' && Number.isInteger(g.value)) {
      const idx = g.value;
      if (idx < 1 || idx > sc.items.length) {
        throw new SqlError(`GROUP BY position ${idx} is not in the select list`, g.start, g.end,
          `The select list has ${sc.items.length} item${plural(sc.items.length)}, so you can use 1–${sc.items.length}.`);
      }
      const item = sc.items[idx - 1];
      return { expr: item.expr, label: item.alias ?? this.labelFor(item) };
    }
    // bare name that isn't a real column but matches a select alias (Postgres allows this)
    if (g.kind === 'col' && !g.table) {
      const idx = this.findColIndex(g, rel.cols);
      if (idx === null) {
        const alias = sc.items.find((it) => it.alias?.toLowerCase() === (g as ColRef).name.toLowerCase());
        if (alias) return { expr: alias.expr, label: alias.alias! };
      }
    }
    return { expr: g, label: this.short(this.text(g), 30) };
  }

  labelFor(item: SelectItem): string {
    if (item.alias) return item.alias;
    if (item.expr.kind === 'col') return (item.expr as ColRef).name;
    return this.short(this.text(item.expr), 30);
  }

  aggLabel(call: Call, sc: SelectCore): string {
    const match = sc.items.find(
      (it) => it.alias && this.norm(it.expr) === this.norm(call),
    );
    return match?.alias ?? this.short(this.text(call), 30);
  }

  windowLabel(call: Call, sc: SelectCore): string {
    const match = sc.items.find(
      (it) => it.alias && this.norm(it.expr) === this.norm(call),
    );
    return match?.alias ?? this.short(this.text(call), 30);
  }

  expandStars(
    sc: SelectCore,
    rel: Relation,
    baseColCount: number,
    grouped: boolean,
  ): { expr: Expr; alias?: string; label: string }[] {
    const out: { expr: Expr; alias?: string; label: string }[] = [];
    for (const item of sc.items) {
      if (item.expr.kind === 'star') {
        const star = item.expr;
        const cols = rel.cols.slice(0, baseColCount).filter(
          (c) => !star.table || (c.source && c.source.toLowerCase() === star.table.toLowerCase()),
        );
        if (star.table && cols.length === 0) {
          throw new SqlError(`Unknown table "${star.table}" in ${star.table}.*`, star.start, star.end);
        }
        if (grouped) {
          // let normal group-context resolution produce the teaching error per column
        }
        for (const c of cols) {
          const ref: ColRef = { kind: 'col', table: c.source, name: c.name, start: star.start, end: star.end };
          out.push({ expr: ref, label: c.name });
        }
      } else {
        out.push({ expr: item.expr, alias: item.alias, label: item.alias ?? this.labelFor(item) });
      }
    }
    return out;
  }

  // ---------- set operations ----------

  execBody(body: QueryBody, env: Env, path: string[]): Relation {
    if (body.kind === 'select') return this.execSelect(body, env, path);
    if (body.kind === 'setop') return this.execSetOp(body, env, path);
    return this.execQuery(body, env, path);
  }

  execSetOp(op: SetOp, env: Env, path: string[]): Relation {
    const opName = op.op === 'unionAll' ? 'UNION ALL' : op.op.toUpperCase();
    const left = this.execBody(op.left, env, [...path, `${opName} — branch 1`]);
    const right = this.execBody(op.right, env, [...path, `${opName} — branch 2`]);
    if (left.cols.length !== right.cols.length) {
      throw new SqlError(
        `Each side of ${opName} must return the same number of columns (first has ${left.cols.length}, second has ${right.cols.length})`,
        op.opSpan.start, op.opSpan.end,
        'Set operations stack results vertically, so the columns must line up one-for-one.',
      );
    }
    const cols = left.cols.map((c) => ({ ...c }));
    const lRows = left.rows.map((r) => ({ id: `a:${r.id}`, vals: r.vals }));
    const rRows = right.rows.map((r) => ({ id: `b:${r.id}`, vals: r.vals }));
    const all = [...lRows, ...rRows];
    const rowStatus = new Map<string, RowStatus>();
    const notes = new Map<string, string>();
    const groups = new Map<string, number>();
    lRows.forEach((r) => groups.set(r.id, 0));
    rRows.forEach((r) => groups.set(r.id, 1));
    let result: RelRow[] = [];
    let desc = '';

    if (op.op === 'unionAll') {
      result = all;
      desc = `The two results are stacked: ${lRows.length} + ${rRows.length} = ${all.length} rows. UNION ALL keeps duplicates.`;
    } else if (op.op === 'union') {
      const seen = new Set<string>();
      let dups = 0;
      for (const r of all) {
        const k = groupKey(r.vals);
        if (seen.has(k)) {
          rowStatus.set(r.id, 'dropped');
          notes.set(r.id, 'duplicate removed by UNION');
          dups++;
        } else {
          seen.add(k);
          result.push(r);
        }
      }
      desc = `The two results are stacked (${lRows.length} + ${rRows.length} rows)${dups ? ` and ${dups} duplicate row${plural(dups)} ${dups === 1 ? 'is' : 'are'} removed` : '; there were no duplicates to remove'} — ${result.length} row${plural(result.length)} remain.`;
    } else if (op.op === 'intersect') {
      const rightKeys = new Set(rRows.map((r) => groupKey(r.vals)));
      const seen = new Set<string>();
      for (const r of lRows) {
        const k = groupKey(r.vals);
        if (rightKeys.has(k) && !seen.has(k)) {
          seen.add(k);
          result.push(r);
          rowStatus.set(r.id, 'kept');
        } else {
          rowStatus.set(r.id, 'dropped');
          notes.set(r.id, rightKeys.has(k) ? 'duplicate' : 'not present in the second result');
        }
      }
      rRows.forEach((r) => {
        rowStatus.set(r.id, 'dropped');
        notes.set(r.id, 'second result — used only for comparison');
      });
      desc = `INTERSECT keeps only rows that appear in both results: ${result.length} row${plural(result.length)}.`;
    } else {
      const rightKeys = new Set(rRows.map((r) => groupKey(r.vals)));
      const seen = new Set<string>();
      for (const r of lRows) {
        const k = groupKey(r.vals);
        if (!rightKeys.has(k) && !seen.has(k)) {
          seen.add(k);
          result.push(r);
          rowStatus.set(r.id, 'kept');
        } else {
          rowStatus.set(r.id, 'dropped');
          notes.set(r.id, rightKeys.has(k) ? 'also appears in the second result' : 'duplicate');
        }
      }
      rRows.forEach((r) => {
        rowStatus.set(r.id, 'dropped');
        notes.set(r.id, 'second result — used only for comparison');
      });
      desc = `EXCEPT keeps rows from the first result that do NOT appear in the second: ${result.length} row${plural(result.length)}.`;
    }

    const sources = [...left.sources, ...right.sources];
    this.pushStep({
      phase: 'setop',
      chip: opName,
      title: `${opName}: combine the two results`,
      desc,
      insight: op.op === 'union' ? 'UNION quietly removes duplicate rows. If you want to keep them (it\'s also faster), use UNION ALL.' : undefined,
      span: op.opSpan,
      path,
      sources: this.tag(sources),
      table: this.viz({ cols, rows: all, sources }, { rowStatus, notes, groups }),
    });
    return { cols, rows: result, sources };
  }

  // ---------- ORDER BY / LIMIT ----------

  applyTailOnOutput(rel: Relation, q: Query, path: string[]): Relation {
    if (q.orderBy) {
      rel = this.applyOrderBy(rel, q, path, (_rowId, e) => {
        throw new SqlError(
          'ORDER BY after a set operation can only use output column names or positions',
          e.start, e.end,
          'Refer to a column of the combined result (by its name in the first branch, or by position like ORDER BY 1).',
        );
      });
    }
    return this.applyLimit(rel, q, path);
  }

  applyOrderBy(
    rel: Relation,
    q: Query,
    path: string[],
    fallbackEval: (rowId: string, e: Expr) => Value,
  ): Relation {
    if (!q.orderBy || rel.rows.length === 0) return rel;
    const keyFns = q.orderBy.map((item) => {
      const e = item.expr;
      if (e.kind === 'num' && Number.isInteger(e.value)) {
        const idx = e.value;
        if (idx < 1 || idx > rel.cols.length) {
          throw new SqlError(`ORDER BY position ${idx} is not in the select list`, e.start, e.end,
            `The result has ${rel.cols.length} column${plural(rel.cols.length)}.`);
        }
        return (r: RelRow) => r.vals[idx - 1];
      }
      if (e.kind === 'col' && !e.table) {
        const matches = rel.cols
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c.name.toLowerCase() === (e as ColRef).name.toLowerCase());
        if (matches.length === 1) {
          const idx = matches[0].i;
          return (r: RelRow) => r.vals[idx];
        }
      }
      return (r: RelRow) => fallbackEval(r.id, e);
    });

    const decorated = rel.rows.map((r, i) => ({ r, i, keys: keyFns.map((f) => f(r)) }));
    decorated.sort((a, b) => {
      for (let k = 0; k < keyFns.length; k++) {
        const item = q.orderBy![k];
        const av = a.keys[k];
        const bv = b.keys[k];
        const aNull = av === null;
        const bNull = bv === null;
        if (aNull || bNull) {
          if (aNull && bNull) continue;
          const nullsFirst = item.nulls ? item.nulls === 'first' : item.desc;
          return aNull ? (nullsFirst ? -1 : 1) : nullsFirst ? 1 : -1;
        }
        const c = orderCompare(av, bv);
        if (c !== 0) return item.desc ? -c : c;
      }
      return a.i - b.i; // stable
    });
    const sorted = decorated.map((d) => d.r);
    const out: Relation = { cols: rel.cols, rows: sorted, sources: rel.sources };
    this.pushStep({
      phase: 'orderby',
      chip: 'ORDER BY',
      title: this.short(`ORDER BY ${q.orderBy.map((o) => this.short(this.text(o), 26)).join(', ')}`, 70),
      desc: `Rows are re-arranged by ${q.orderBy.map((o) => `${this.short(this.text(o.expr), 24)} ${o.desc ? 'descending' : 'ascending'}`).join(', then ')}. No rows appear or disappear — only the order changes.`,
      insight: 'Without ORDER BY, SQL guarantees no particular row order. Sorting is one of the last things the database does.',
      span: q.orderSpan,
      path,
      sources: this.tag(out.sources),
      table: this.viz(out),
    });
    return out;
  }

  applyLimit(rel: Relation, q: Query, path: string[]): Relation {
    if (q.limit === undefined && q.offset === undefined) return rel;
    const off = q.offset ?? 0;
    const lim = q.limit ?? rel.rows.length;
    const rowStatus = new Map<string, RowStatus>();
    const notes = new Map<string, string>();
    const kept: RelRow[] = [];
    rel.rows.forEach((r, i) => {
      if (i < off) {
        rowStatus.set(r.id, 'dropped');
        notes.set(r.id, `skipped by OFFSET ${off}`);
      } else if (i < off + lim) {
        rowStatus.set(r.id, 'kept');
        kept.push(r);
      } else {
        rowStatus.set(r.id, 'dropped');
        notes.set(r.id, `beyond LIMIT ${lim}`);
      }
    });
    this.pushStep({
      phase: 'limit',
      chip: 'LIMIT',
      title: `LIMIT ${q.limit ?? ''}${q.offset ? ` OFFSET ${q.offset}` : ''}`.trim(),
      desc: `${kept.length} row${plural(kept.length)} kept; ${rel.rows.length - kept.length} cut off.`,
      insight: q.orderBy ? undefined : 'Careful: without an ORDER BY, LIMIT keeps an *arbitrary* set of rows — the database promises nothing about which ones.',
      span: q.limitSpan,
      path,
      sources: this.tag(rel.sources),
      table: this.viz(rel, { rowStatus, notes }),
    });
    return { cols: rel.cols, rows: kept, sources: rel.sources };
  }

  // ---------- window computation ----------

  computeWindow(
    call: Call,
    rel: Relation,
    ctxFor: (row: RelRow) => Ctx,
  ): { values: Map<string, Value>; partitions: Map<string, number>; ordered: RelRow[] } {
    const spec = call.over!;
    const name = call.name;
    if (!WINDOW_ONLY_FUNCS.has(name) && !AGG_FUNC_NAMES.has(name)) {
      throw new SqlError(`Unknown window function ${name}()`, call.start, call.end,
        'Available: row_number, rank, dense_rank, ntile, lag, lead, first_value, last_value, and aggregates like sum/avg/count/min/max.');
    }
    const evalIn = (e: Expr, row: RelRow): Value => {
      const ctx = ctxFor(row);
      ctx.clause = 'window';
      return this.evalExpr(e, ctx);
    };
    // partition rows
    const partsMap = new Map<string, RelRow[]>();
    const partOrder: string[] = [];
    for (const row of rel.rows) {
      this.tick();
      const k = groupKey(spec.partitionBy.map((p) => evalIn(p, row)));
      if (!partsMap.has(k)) {
        partsMap.set(k, []);
        partOrder.push(k);
      }
      partsMap.get(k)!.push(row);
    }
    const values = new Map<string, Value>();
    const partitions = new Map<string, number>();
    const ordered: RelRow[] = [];

    partOrder.forEach((k, pi) => {
      let rows = partsMap.get(k)!;
      // sort within partition
      if (spec.orderBy.length) {
        const dec = rows.map((r, i) => ({ r, i, keys: spec.orderBy.map((o) => evalIn(o.expr, r)) }));
        dec.sort((a, b) => {
          for (let j = 0; j < spec.orderBy.length; j++) {
            const o = spec.orderBy[j];
            const av = a.keys[j];
            const bv = b.keys[j];
            const aNull = av === null;
            const bNull = bv === null;
            if (aNull || bNull) {
              if (aNull && bNull) continue;
              const nullsFirst = o.nulls ? o.nulls === 'first' : o.desc;
              return aNull ? (nullsFirst ? -1 : 1) : nullsFirst ? 1 : -1;
            }
            const c = orderCompare(av, bv);
            if (c !== 0) return o.desc ? -c : c;
          }
          return a.i - b.i;
        });
        rows = dec.map((d) => d.r);
      }
      rows.forEach((r) => {
        partitions.set(r.id, pi);
        ordered.push(r);
      });

      // peer groups (ties in ORDER BY)
      const orderKeys = rows.map((r) => groupKey(spec.orderBy.map((o) => evalIn(o.expr, r))));
      const argVals = (idx: number): Value[] =>
        call.args.map((a) => (a.kind === 'star' ? 1 : evalIn(a, rows[idx])));

      if (name === 'row_number') {
        rows.forEach((r, i) => values.set(r.id, i + 1));
      } else if (name === 'rank' || name === 'dense_rank') {
        let rank = 0;
        let dense = 0;
        rows.forEach((r, i) => {
          if (i === 0 || orderKeys[i] !== orderKeys[i - 1]) {
            rank = i + 1;
            dense++;
          }
          values.set(r.id, name === 'rank' ? rank : dense);
        });
      } else if (name === 'ntile') {
        const n = call.args.length ? Number(evalIn(call.args[0], rows[0])) : 1;
        if (!n || n < 1) throw new SqlError('ntile() needs a positive bucket count', call.start, call.end);
        const size = Math.floor(rows.length / n);
        const extra = rows.length % n;
        let idx = 0;
        for (let b = 1; b <= n && idx < rows.length; b++) {
          const cnt = size + (b <= extra ? 1 : 0);
          for (let j = 0; j < cnt && idx < rows.length; j++, idx++) values.set(rows[idx].id, b);
        }
      } else if (name === 'lag' || name === 'lead') {
        if (call.args.length < 1) throw new SqlError(`${name}() needs at least one argument`, call.start, call.end);
        const offset = call.args.length >= 2 ? Number(evalIn(call.args[1], rows[0])) : 1;
        rows.forEach((r, i) => {
          const j = name === 'lag' ? i - offset : i + offset;
          if (j >= 0 && j < rows.length) {
            values.set(r.id, evalIn(call.args[0], rows[j]));
          } else {
            values.set(r.id, call.args.length >= 3 ? evalIn(call.args[2], r) : null);
          }
        });
      } else if (name === 'first_value' || name === 'last_value' || AGG_FUNC_NAMES.has(name)) {
        // frame-based
        rows.forEach((r, i) => {
          const [lo, hi] = this.frameRange(spec, rows.length, i, orderKeys);
          const frameRows = rows.slice(lo, hi + 1);
          if (name === 'first_value') {
            values.set(r.id, frameRows.length ? evalIn(call.args[0], frameRows[0]) : null);
          } else if (name === 'last_value') {
            values.set(r.id, frameRows.length ? evalIn(call.args[0], frameRows[frameRows.length - 1]) : null);
          } else {
            const star = call.args.length === 1 && call.args[0].kind === 'star';
            const vals = frameRows.map((fr) =>
              star ? 1 : call.args.length ? evalIn(call.args[0], fr) : 1,
            );
            values.set(r.id, computeAggregate(name, star ? frameRows.map(() => 1) : vals, star, !!call.distinct, call));
          }
        });
      }
      void argVals;
    });
    return { values, partitions, ordered };
  }

  frameRange(spec: WindowSpec, n: number, i: number, orderKeys: string[]): [number, number] {
    if (!spec.frame) {
      if (spec.orderBy.length === 0) return [0, n - 1];
      // default RANGE UNBOUNDED PRECEDING → CURRENT ROW (including peers)
      let hi = i;
      while (hi + 1 < n && orderKeys[hi + 1] === orderKeys[i]) hi++;
      return [0, hi];
    }
    const bound = (b: { type: string; offset?: number }, isStart: boolean): number => {
      switch (b.type) {
        case 'unboundedPreceding': return 0;
        case 'unboundedFollowing': return n - 1;
        case 'currentRow': return i;
        case 'preceding': return Math.max(0, i - (b.offset ?? 0));
        case 'following': return Math.min(n - 1, i + (b.offset ?? 0));
        default: return isStart ? 0 : n - 1;
      }
    };
    return [bound(spec.frame.start, true), bound(spec.frame.end, false)];
  }

  // ---------- expression evaluation ----------

  findColIndex(ref: ColRef, cols: RelCol[]): number | null {
    const name = ref.name.toLowerCase();
    const table = ref.table?.toLowerCase();
    const matches: number[] = [];
    cols.forEach((c, i) => {
      if (c.name.toLowerCase() !== name) return;
      if (table && c.source?.toLowerCase() !== table) return;
      matches.push(i);
    });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      const sources = matches.map((i) => cols[i].source ?? '?').join('", "');
      throw new SqlError(
        `Column "${ref.name}" is ambiguous — it exists in "${sources}"`,
        ref.start, ref.end,
        `Qualify it with the table alias, e.g. ${cols[matches[0]].source ?? 't'}.${ref.name}.`,
      );
    }
    return matches[0];
  }

  resolveColumn(ref: ColRef, ctx: Ctx): Value {
    // group context: is this a GROUP BY key?
    if (ctx.group) {
      const idx = this.findColIndex(ref, ctx.cols);
      if (idx !== null) {
        const keyPos = ctx.keyColIdx?.get(idx);
        if (keyPos !== undefined) return ctx.group.keyVals[keyPos];
        throw new SqlError(
          `Column "${ref.name}" must appear in the GROUP BY clause or be used in an aggregate function`,
          ref.start, ref.end,
          `After grouping, each output row stands for a whole group — SQL no longer knows *which* single ${ref.name} to show. Group by it, or wrap it in an aggregate like MIN(${ref.name}).`,
        );
      }
    } else {
      const idx = this.findColIndex(ref, ctx.cols);
      if (idx !== null) {
        if (!ctx.row) throw new SqlError(`Column "${ref.name}" cannot be used here`, ref.start, ref.end);
        return ctx.row.vals[idx];
      }
    }
    // correlated subquery: try enclosing query's row (or group keys)
    for (let i = this.outerStack.length - 1; i >= 0; i--) {
      const frame = this.outerStack[i];
      const octx = frame.ctx;
      try {
        const idx = this.findColIndex(ref, octx.cols);
        if (idx === null) continue;
        if (octx.group) {
          const keyPos = octx.keyColIdx?.get(idx);
          if (keyPos !== undefined) {
            frame.used.hit = true;
            return octx.group.keyVals[keyPos];
          }
        } else if (octx.row) {
          frame.used.hit = true;
          return octx.row.vals[idx];
        }
      } catch {
        // ambiguity in outer scope — keep looking
      }
    }
    // helpful errors
    const aliasMatch = ctx.aliases?.find((a) => a.name.toLowerCase() === ref.name.toLowerCase());
    if (aliasMatch && (ctx.clause === 'WHERE' || ctx.clause === 'HAVING' || ctx.clause === 'ON')) {
      throw new SqlError(
        `Column "${ref.name}" does not exist here — it's an alias defined in SELECT`,
        ref.start, ref.end,
        `${ctx.clause} runs *before* SELECT names its output columns, so the alias isn't visible yet. Repeat the expression instead (or move the query into a subquery/CTE and filter that).`,
      );
    }
    const available = [...new Set(ctx.cols.map((c) => (c.source ? `${c.source}.${c.name}` : c.name)))];
    const quotedHint = (ref as ColRef & { quoted?: boolean }).quoted
      ? `Double quotes refer to a *column* named "${ref.name}". If you meant the text value, use single quotes: '${ref.name}'.`
      : undefined;
    throw new SqlError(
      `Column "${ref.table ? ref.table + '.' : ''}${ref.name}" does not exist`,
      ref.start, ref.end,
      quotedHint ?? (available.length ? `Available columns: ${available.slice(0, 12).join(', ')}${available.length > 12 ? ', …' : ''}.` : undefined),
    );
  }

  computeAggForGroup(call: Call, group: GroupCtx, base: Omit<Ctx, 'row' | 'group'>): Value {
    const key = this.norm(call) + (call.distinct ? '|d' : '');
    if (group.aggCache.has(key)) return group.aggCache.get(key)!;
    const isStar = call.args.length === 1 && call.args[0].kind === 'star';
    let vals: Value[];
    if (isStar) {
      vals = group.rows.map(() => 1);
    } else {
      if (call.args.length !== 1) {
        throw new SqlError(`${call.name}() expects exactly one argument`, call.start, call.end,
          call.name === 'count' ? 'Use COUNT(*) to count rows, or COUNT(column) to count non-NULL values.' : undefined);
      }
      vals = group.rows.map((r) =>
        this.evalExpr(call.args[0], { ...base, row: r, group: undefined, clause: 'aggregate' } as Ctx),
      );
    }
    const v = computeAggregate(call.name, vals, isStar, !!call.distinct, call);
    group.aggCache.set(key, v);
    return v;
  }

  evalExpr(e: Expr, ctx: Ctx): Value {
    // In a group context, any expression matching a GROUP BY key resolves to the key value
    if (ctx.group && ctx.keySqls) {
      const idx = ctx.keySqls.indexOf(this.norm(e));
      if (idx !== -1) return ctx.group.keyVals[idx];
    }
    switch (e.kind) {
      case 'num': return e.value;
      case 'str': return e.value;
      case 'bool': return e.value;
      case 'null': return null;
      case 'interval': return parseIntervalLiteral(e.text, e);
      case 'col': return this.resolveColumn(e, ctx);
      case 'star':
        throw new SqlError('* can only be used in the SELECT list or in COUNT(*)', e.start, e.end);
      case 'unary': {
        if (e.op === 'not') {
          const v = this.evalExpr(e.operand, ctx);
          if (v === null) return null;
          return !truthy(v);
        }
        const v = this.evalExpr(e.operand, ctx);
        if (v === null) return null;
        if (typeof v !== 'number') throw new SqlError(`Cannot apply unary ${e.op} to a non-number`, e.start, e.end);
        return e.op === '-' ? -v : v;
      }
      case 'binary': return this.evalBinary(e, ctx);
      case 'case': {
        if (e.operand) {
          const base = this.evalExpr(e.operand, ctx);
          for (const b of e.branches) {
            const w = this.evalExpr(b.when, ctx);
            if (base !== null && w !== null && compareValues(base, w) === 0) return this.evalExpr(b.then, ctx);
          }
        } else {
          for (const b of e.branches) {
            if (truthy(this.evalExpr(b.when, ctx))) return this.evalExpr(b.then, ctx);
          }
        }
        return e.elseExpr ? this.evalExpr(e.elseExpr, ctx) : null;
      }
      case 'cast': return this.evalCast(this.evalExpr(e.operand, ctx), e.type, e);
      case 'extract': return extractField(e.field, this.evalExpr(e.operand, ctx), e);
      case 'isnull': {
        const v = this.evalExpr(e.operand, ctx);
        return e.negated ? v !== null : v === null;
      }
      case 'between': {
        const v = this.evalExpr(e.operand, ctx);
        const lo = this.evalExpr(e.low, ctx);
        const hi = this.evalExpr(e.high, ctx);
        const c1 = compareValues(v, lo);
        const c2 = compareValues(v, hi);
        if (c1 === null || c2 === null) return null;
        const r = c1 >= 0 && c2 <= 0;
        return e.negated ? !r : r;
      }
      case 'like': {
        const v = this.evalExpr(e.operand, ctx);
        const p = this.evalExpr(e.pattern, ctx);
        if (v === null || p === null) return null;
        const regex = likeToRegex(String(p), e.caseInsensitive);
        const r = regex.test(String(v));
        return e.negated ? !r : r;
      }
      case 'in': return this.evalIn(e, ctx);
      case 'exists': {
        const rel = this.evalSubqueryRel(e.query, ctx, 'Subquery (EXISTS)');
        const r = rel.rows.length > 0;
        return e.negated ? !r : r;
      }
      case 'subquery': {
        const rel = this.evalSubqueryRel(e.query, ctx, `Subquery in ${ctx.clause}`);
        if (rel.cols.length !== 1) {
          throw new SqlError(
            `This subquery is used as a single value but returns ${rel.cols.length} columns`,
            e.start, e.end, 'A subquery used inside an expression must return exactly one column.',
          );
        }
        if (rel.rows.length > 1) {
          throw new SqlError(
            `This subquery is used as a single value but returned ${rel.rows.length} rows`,
            e.start, e.end,
            'Comparing against many values? Use IN (subquery) instead of =, or aggregate the subquery down to one row.',
          );
        }
        return rel.rows.length ? rel.rows[0].vals[0] : null;
      }
      case 'call': return this.evalCall(e, ctx);
    }
  }

  evalBinary(e: Extract<Expr, { kind: 'binary' }>, ctx: Ctx): Value {
    const op = e.op;
    if (op === 'and') {
      const l = this.evalExpr(e.left, ctx);
      if (l === false) return false;
      const r = this.evalExpr(e.right, ctx);
      if (r === false) return false;
      if (l === null || r === null) return null;
      return truthy(l) && truthy(r);
    }
    if (op === 'or') {
      const l = this.evalExpr(e.left, ctx);
      if (l === true) return true;
      const r = this.evalExpr(e.right, ctx);
      if (r === true) return true;
      if (l === null || r === null) return null;
      return truthy(l) || truthy(r);
    }
    const l = this.evalExpr(e.left, ctx);
    const r = this.evalExpr(e.right, ctx);
    if (['=', '<>', '<', '<=', '>', '>='].includes(op)) {
      const c = compareValues(l, r);
      if (c === null) return null;
      switch (op) {
        case '=': return c === 0;
        case '<>': return c !== 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        case '>=': return c >= 0;
      }
    }
    if (op === '||') {
      if (l === null || r === null) return null;
      return `${formatConcat(l)}${formatConcat(r)}`;
    }
    if (l === null || r === null) return null;
    // date/interval arithmetic
    if (typeof l === 'string' && isDateLike(l)) {
      if (typeof r === 'string' && isDateLike(r) && op === '-') {
        return { kind: 'interval', ms: toDate(l).getTime() - toDate(r).getTime() };
      }
      if (isInterval(r) && (op === '+' || op === '-')) {
        const ms = toDate(l).getTime() + (op === '+' ? r.ms : -r.ms);
        return fromDate(new Date(ms), l.includes(':') || r.ms % 86400000 !== 0);
      }
      if (typeof r === 'number' && (op === '+' || op === '-') && !l.includes(':')) {
        // date +/- integer days (Postgres date arithmetic)
        const ms = toDate(l).getTime() + (op === '+' ? r : -r) * 86400000;
        return fromDate(new Date(ms), false);
      }
    }
    if (isInterval(l)) {
      if (isInterval(r) && (op === '+' || op === '-')) {
        return { kind: 'interval', ms: op === '+' ? l.ms + r.ms : l.ms - r.ms };
      }
      if (typeof r === 'number' && op === '*') return { kind: 'interval', ms: l.ms * r };
      if (typeof r === 'string' && isDateLike(r) && op === '+') {
        return fromDate(new Date(toDate(r).getTime() + l.ms), true);
      }
    }
    const ln = toNumber(l, e.left, 'arithmetic');
    const rn = toNumber(r, e.right, 'arithmetic');
    switch (op) {
      case '+': return ln + rn;
      case '-': return ln - rn;
      case '*': return ln * rn;
      case '%': {
        if (rn === 0) throw new SqlError('division by zero', e.start, e.end);
        return ln % rn;
      }
      case '/': {
        if (rn === 0) {
          throw new SqlError('division by zero', e.start, e.end,
            'Something in the data made this denominator 0. Guard it with NULLIF(denominator, 0) — dividing by NULL gives NULL instead of an error.');
        }
        const intDiv = this.isIntExpr(e.left, ctx.cols) && this.isIntExpr(e.right, ctx.cols);
        const v = ln / rn;
        return intDiv ? Math.trunc(v) : v;
      }
    }
    throw new SqlError(`Unsupported operator ${op}`, e.start, e.end);
  }

  evalIn(e: Extract<Expr, { kind: 'in' }>, ctx: Ctx): Value {
    if (e.query) {
      // subquery IN-list: membership via a hashed set (built once for
      // uncorrelated subqueries) so big tables stay fast
      const rel = this.evalSubqueryRel(e.query, ctx, `Subquery in ${ctx.clause} (IN list)`);
      if (rel.cols.length !== 1) {
        throw new SqlError(`The subquery in IN (...) must return exactly one column, not ${rel.cols.length}`, e.start, e.end);
      }
      const cacheable = this.subqCache.get(e.query) === rel;
      let entry = cacheable ? this.inSetCache.get(e.query) : undefined;
      if (!entry) {
        entry = { set: new Set<string>(), hasNull: false };
        for (const r of rel.rows) {
          const item = r.vals[0];
          if (item === null) entry.hasNull = true;
          else entry.set.add(groupKey([item]));
        }
        if (cacheable) this.inSetCache.set(e.query, entry);
      }
      const v = this.evalExpr(e.operand, ctx);
      let result: Value;
      if (v !== null && entry.set.has(groupKey([v]))) result = true;
      else if (v === null || entry.hasNull) result = null;
      else result = false;
      if (e.negated) result = result === null ? null : !result;
      return result;
    }
    const v = this.evalExpr(e.operand, ctx);
    const list = e.list!.map((x) => this.evalExpr(x, ctx));
    let sawNull = v === null;
    let found = false;
    for (const item of list) {
      if (item === null) {
        sawNull = true;
        continue;
      }
      if (v !== null && compareValues(v, item) === 0) {
        found = true;
        break;
      }
    }
    let result: Value;
    if (found) result = true;
    else if (sawNull) result = null;
    else result = false;
    if (e.negated) result = result === null ? null : !result;
    return result;
  }

  evalCall(e: Call, ctx: Ctx): Value {
    const name = e.name;
    if (e.over) {
      const v = ctx.windowVals?.get(e)?.get(ctx.row?.id ?? '');
      if (v === undefined) {
        throw new SqlError(
          `Window functions are only allowed in the SELECT list and ORDER BY`,
          e.start, e.end,
          'To filter or group by a window value, compute it in a subquery or CTE first.',
        );
      }
      return v;
    }
    if (AGG_FUNC_NAMES.has(name)) {
      if (ctx.group) {
        return this.computeAggForGroup(e, ctx.group, {
          cols: ctx.cols, env: ctx.env, clause: 'aggregate',
          aliases: ctx.aliases, path: ctx.path,
        } as Omit<Ctx, 'row' | 'group'>);
      }
      if (ctx.clause === 'WHERE' || ctx.clause === 'ON') {
        throw new SqlError(`Aggregate functions are not allowed in ${ctx.clause}`, e.start, e.end,
          'Aggregates need groups to work on. Use HAVING (after GROUP BY), or compute the value in a subquery.');
      }
      if (ctx.clause === 'aggregate') {
        throw new SqlError('Aggregate functions cannot be nested', e.start, e.end,
          'Compute the inner aggregate in a subquery or CTE, then aggregate over that result.');
      }
      throw new SqlError(`Aggregate function ${name}() is not valid here`, e.start, e.end);
    }
    if (WINDOW_ONLY_FUNCS.has(name)) {
      throw new SqlError(`${name}() is a window function — it needs an OVER (...) clause`, e.start, e.end,
        `Try ${name}(...) OVER (PARTITION BY ... ORDER BY ...).`);
    }
    const fn = SCALAR_FUNCS[name];
    if (!fn) {
      throw new SqlError(`Unknown function ${name}()`, e.start, e.end,
        'Supported: upper, lower, length, trim, concat, left, right, substr, replace, coalesce, nullif, round, ceil, floor, abs, power, mod, date_trunc, date_part, to_char, now, and more.');
    }
    const args = e.args.map((a) => {
      if (a.kind === 'star') throw new SqlError(`* is not a valid argument for ${name}()`, a.start, a.end);
      return this.evalExpr(a, ctx);
    });
    return fn(args, e);
  }

  evalCast(v: Value, type: string, sp: Span): Value {
    if (v === null) return null;
    switch (type) {
      case 'int': case 'integer': case 'bigint': case 'smallint': {
        if (typeof v === 'number') return Math.round(v);
        const n = Number(String(v).trim());
        if (isNaN(n)) {
          throw new SqlError(`Cannot convert '${String(v)}' to an integer`, sp.start, sp.end,
            'The text must look like a number for the cast to work.');
        }
        return Math.round(n);
      }
      case 'numeric': case 'decimal': case 'real': case 'float': case 'double precision': {
        if (typeof v === 'number') return v;
        const n = Number(String(v).trim());
        if (isNaN(n)) throw new SqlError(`Cannot convert '${String(v)}' to a number`, sp.start, sp.end);
        return n;
      }
      case 'text': case 'varchar': case 'char': case 'bpchar': case 'string':
        return isInterval(v) ? formatValue(v) : String(v);
      case 'date': {
        const s = String(v);
        if (isDateLike(s)) return s.slice(0, 10);
        throw new SqlError(`Cannot convert '${s}' to a date`, sp.start, sp.end,
          "Dates look like '2024-05-10'.");
      }
      case 'timestamp': {
        const s = String(v);
        if (isDateLike(s)) return s.length === 10 ? `${s} 00:00:00` : s;
        throw new SqlError(`Cannot convert '${s}' to a timestamp`, sp.start, sp.end);
      }
      case 'boolean': case 'bool': {
        if (typeof v === 'boolean') return v;
        const s = String(v).toLowerCase().trim();
        if (['t', 'true', 'yes', 'y', '1'].includes(s)) return true;
        if (['f', 'false', 'no', 'n', '0'].includes(s)) return false;
        throw new SqlError(`Cannot convert '${String(v)}' to a boolean`, sp.start, sp.end);
      }
      default:
        throw new SqlError(`Unsupported cast target type "${type}"`, sp.start, sp.end,
          'Try int, numeric, text, date, timestamp, or boolean.');
    }
  }

  // ---------- subqueries ----------

  evalSubqueryRel(q: Query, ctx: Ctx, label: string): Relation {
    const cached = this.subqCache.get(q);
    if (cached) return cached;
    const used = { hit: false };
    this.outerStack.push({ ctx, used });
    const alreadyShown = this.subqSeen.has(q);
    if (alreadyShown) this.silentDepth++;
    let rel: Relation;
    try {
      rel = this.execQuery(q, ctx.env, [...ctx.path, label]);
    } finally {
      if (alreadyShown) this.silentDepth--;
      this.outerStack.pop();
    }
    if (!alreadyShown) {
      this.subqSeen.add(q);
      const single = rel.rows.length === 1 && rel.cols.length === 1;
      this.pushStep({
        phase: 'subquery',
        chip: 'SUB ✓',
        title: single
          ? `Subquery result: ${formatValue(rel.rows[0].vals[0])}`
          : `Subquery result: ${rel.rows.length} row${plural(rel.rows.length)}`,
        desc:
          (used.hit
            ? 'This subquery uses columns from the outer query (it is *correlated*), so it re-runs for every outer row — the steps above show the first evaluation. '
            : 'This subquery does not depend on the outer row, so SQL evaluates it once and reuses the value. ') +
          'The outer query now continues with this result plugged in.',
        span: { start: q.start, end: q.end },
        path: ctx.path,
        sources: this.tag(rel.sources),
        table: this.plainViz(rel),
      });
    }
    if (!used.hit) this.subqCache.set(q, rel);
    return rel;
  }

  // ---------- static analysis ----------

  containsAgg(e: Expr): boolean {
    let found = false;
    this.walk(e, (x) => {
      if (x.kind === 'call' && AGG_FUNC_NAMES.has(x.name) && !x.over) found = true;
    });
    return found;
  }

  containsWindow(e: Expr): boolean {
    let found = false;
    this.walk(e, (x) => {
      if (x.kind === 'call' && x.over) found = true;
    });
    return found;
  }

  collectAggCalls(e: Expr, out: Call[], seen: Set<string>): void {
    this.walk(e, (x) => {
      if (x.kind === 'call' && AGG_FUNC_NAMES.has(x.name) && !x.over) {
        const key = this.norm(x) + (x.distinct ? '|d' : '');
        if (!seen.has(key)) {
          seen.add(key);
          out.push(x);
        }
      }
    });
  }

  collectWindowCalls(e: Expr, out: Call[]): void {
    this.walk(e, (x) => {
      if (x.kind === 'call' && x.over && !out.includes(x)) out.push(x);
    });
  }

  /** Walk an expression tree, NOT descending into subqueries. */
  walk(e: Expr, fn: (e: Expr) => void): void {
    fn(e);
    switch (e.kind) {
      case 'unary': this.walk(e.operand, fn); break;
      case 'binary': this.walk(e.left, fn); this.walk(e.right, fn); break;
      case 'case':
        if (e.operand) this.walk(e.operand, fn);
        e.branches.forEach((b) => { this.walk(b.when, fn); this.walk(b.then, fn); });
        if (e.elseExpr) this.walk(e.elseExpr, fn);
        break;
      case 'cast': this.walk(e.operand, fn); break;
      case 'extract': this.walk(e.operand, fn); break;
      case 'in':
        this.walk(e.operand, fn);
        e.list?.forEach((x) => this.walk(x, fn));
        break;
      case 'between': this.walk(e.operand, fn); this.walk(e.low, fn); this.walk(e.high, fn); break;
      case 'like': this.walk(e.operand, fn); this.walk(e.pattern, fn); break;
      case 'isnull': this.walk(e.operand, fn); break;
      case 'call':
        e.args.forEach((a) => this.walk(a, fn));
        if (e.over) {
          e.over.partitionBy.forEach((p) => this.walk(p, fn));
          e.over.orderBy.forEach((o) => this.walk(o.expr, fn));
        }
        break;
      default: break;
    }
  }

  /** Static "is integer-typed" — powers Postgres-style integer division. */
  isIntExpr(e: Expr, cols: RelCol[]): boolean {
    const memo = this.intTypeMemo.get(e);
    if (memo !== undefined) return memo;
    let r = false;
    switch (e.kind) {
      case 'num': r = Number.isInteger(e.value) && !this.text(e).includes('.') && !/e/i.test(this.text(e)); break;
      case 'col': {
        try {
          const idx = this.findColIndex(e, cols);
          r = idx !== null ? !!cols[idx].isInt : false;
        } catch {
          r = false;
        }
        break;
      }
      case 'unary': r = e.op !== 'not' && this.isIntExpr(e.operand, cols); break;
      case 'binary':
        r = ['+', '-', '*', '/', '%'].includes(e.op) &&
          this.isIntExpr(e.left, cols) && this.isIntExpr(e.right, cols);
        break;
      case 'call':
        if (e.name === 'count') r = true;
        else if (['sum', 'min', 'max'].includes(e.name) && e.args.length === 1 && e.args[0].kind !== 'star') {
          r = this.isIntExpr(e.args[0], cols);
        } else if (['row_number', 'rank', 'dense_rank', 'ntile', 'length', 'strpos', 'mod'].includes(e.name)) {
          r = true;
        }
        break;
      case 'case': {
        const branches = [...e.branches.map((b) => b.then), ...(e.elseExpr ? [e.elseExpr] : [])];
        r = branches.length > 0 && branches.every((b) => b.kind === 'null' || this.isIntExpr(b, cols));
        break;
      }
      case 'cast': r = ['int', 'integer', 'bigint', 'smallint'].includes(e.type); break;
      case 'extract': r = true; break;
      default: r = false;
    }
    this.intTypeMemo.set(e, r);
    return r;
  }
}

// ---------- small helpers ----------

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function toNumber(v: Value, sp: Span, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  throw new SqlError(
    `Cannot use '${isInterval(v as Value) ? 'interval' : String(v)}' in ${what} — a number is needed`,
    sp.start, sp.end,
  );
}

function formatConcat(v: Value): string {
  if (isInterval(v)) return formatValue(v);
  return String(v);
}

function likeToRegex(pattern: string, ci: boolean): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'i' : undefined);
}
