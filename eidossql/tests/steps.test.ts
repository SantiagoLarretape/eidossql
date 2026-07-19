// The steps ARE the product: the differential test proves final results
// match Postgres, but nothing else guards the journey — phase order, row
// statuses, stable identities, and the source-color tags on the timeline.
// These tests pin that structure using the curated examples themselves.

import { describe, it, expect } from 'vitest';
import { runQuery } from '../src/engine';
import { parch } from '../src/data/datasets';
import { EXAMPLES } from '../src/ui/examples';

function example(id: string): string {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) throw new Error(`no example ${id}`);
  return ex.sql;
}

describe('step structure', () => {
  it('the HAVING example walks the canonical clause order', () => {
    const { steps } = runQuery(example('having'), parch);
    expect(steps.map((s) => s.phase)).toEqual([
      'from', 'join', 'group', 'group', 'having', 'select', 'orderby', 'result',
    ]);
    expect(steps.every((s) => s.path.length === 0)).toBe(true);
  });

  it('every step carries a SQL span inside the query text', () => {
    const sql = example('having');
    const { steps } = runQuery(sql, parch);
    for (const s of steps) {
      expect(s.span).toBeDefined();
      expect(s.span!.start).toBeGreaterThanOrEqual(0);
      expect(s.span!.end).toBeLessThanOrEqual(sql.length);
    }
  });

  it('inner join shows Mattel as a dropped no-match ghost row', () => {
    const { steps } = runQuery(example('having'), parch);
    const join = steps.find((s) => s.phase === 'join')!;
    const ghost = join.table.rows.find((r) => r.note?.includes('INNER JOIN'));
    expect(ghost).toBeDefined();
    expect(ghost!.status).toBe('dropped');
    expect(ghost!.cells).toContain('Mattel');
  });

  it('LEFT JOIN keeps the no-match row as a NULL-filled "new" row', () => {
    const { steps } = runQuery(example('left-join'), parch);
    const join = steps.find((s) => s.phase === 'join')!;
    const kept = join.table.rows.find((r) => r.status === 'new' && r.cells.includes('Mattel'));
    expect(kept).toBeDefined();
    expect(kept!.cells[kept!.cells.length - 1]).toBeNull();
  });

  it('row identities are stable across ORDER BY (FLIP contract)', () => {
    const { steps } = runQuery(example('having'), parch);
    const select = steps.find((s) => s.phase === 'select')!;
    const orderby = steps.find((s) => s.phase === 'orderby')!;
    const a = new Set(select.table.rows.map((r) => r.id));
    // ORDER BY shows the post-HAVING survivors: same ids, new order
    const survivors = orderby.table.rows.map((r) => r.id);
    expect(survivors.every((id) => a.has(id))).toBe(true);
  });

  it('WHERE marks each row kept or dropped and counts them in the narration', () => {
    const { steps } = runQuery(example('where'), parch);
    const where = steps.find((s) => s.phase === 'where')!;
    const kept = where.table.rows.filter((r) => r.status === 'kept').length;
    const dropped = where.table.rows.filter((r) => r.status === 'dropped').length;
    expect(kept + dropped).toBe(where.table.rows.length);
    expect(where.desc).toContain(`${kept} of ${kept + dropped}`);
  });

  it('window steps add a "new" column labeled by its alias', () => {
    const { steps } = runQuery(example('lag'), parch);
    const win = steps.find((s) => s.phase === 'window')!;
    const col = win.table.columns.find((c) => c.label === 'previous_amt');
    expect(col).toBeDefined();
    expect(col!.status).toBe('new');
  });

  it('LIMIT marks exactly the cut rows', () => {
    const { steps } = runQuery(example('order-limit'), parch);
    const limit = steps.find((s) => s.phase === 'limit')!;
    expect(limit.table.rows.filter((r) => r.status === 'kept')).toHaveLength(5);
    const result = steps[steps.length - 1];
    expect(result.phase).toBe('result');
    expect(result.table.rows).toHaveLength(5);
  });
});

describe('source coloring (timeline chips)', () => {
  const { steps } = runQuery(example('capstone-having'), parch);

  it('CTE-internal steps are sourced to the table they read', () => {
    const first = steps[0];
    expect(first.path[0]).toMatch(/acct_orders/);
    expect(first.sources?.map((s) => s.name)).toEqual(['orders']);
  });

  it('the CTE-ready chip introduces the CTE as its own source', () => {
    const cte = steps.find((s) => s.phase === 'cte')!;
    expect(cte.sources?.map((s) => s.name)).toEqual(['acct_orders']);
  });

  it('the join chip is split between both sides', () => {
    const join = steps.find((s) => s.phase === 'join')!;
    const names = join.sources!.map((s) => s.name);
    expect(names).toEqual(['accounts', 'acct_orders']);
    expect(join.sources![0].color).not.toBe(join.sources![1].color);
  });

  it("the HAVING subquery wears the CTE's color", () => {
    const cte = steps.find((s) => s.phase === 'cte')!;
    const sub = steps.find((s) => s.path.some((p) => p.startsWith('Subquery')))!;
    expect(sub.sources?.map((s) => s.name)).toEqual(['acct_orders']);
    expect(sub.sources![0].color).toBe(cte.sources![0].color);
  });

  it('colors are stable per source across the whole run', () => {
    const byName = new Map<string, number>();
    for (const s of steps) {
      for (const src of s.sources ?? []) {
        const seen = byName.get(src.name);
        if (seen !== undefined) expect(src.color).toBe(seen);
        byName.set(src.name, src.color);
      }
    }
    expect(byName.size).toBeGreaterThanOrEqual(3); // orders, acct_orders, accounts
  });
});
