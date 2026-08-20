// Live-verification logic: skip conditions and the result comparison that
// backs the "✓ verified against your PostgreSQL" badge.

import { describe, it, expect } from 'vitest';
import { runQuery } from '../src/engine';
import { parch } from '../src/data/datasets';
import type { Dataset } from '../src/data/datasets';
import { verifySkipReason, compareResults, hasTopLevelOrderBy } from '../src/data/liveVerify';
import type { PgQueryResult } from '../src/data/liveVerify';

function pg(columns: string[], rows: PgQueryResult['rows']): PgQueryResult {
  return { columns, rows, truncated: false };
}

describe('verifySkipReason', () => {
  const sampledParch: Dataset = {
    ...parch,
    tables: parch.tables.map((t) =>
      t.name === 'orders' ? { ...t, totalRows: 6912 } : t,
    ),
  };

  it('skips when the query reads a sampled table', () => {
    const { steps, result } = runQuery('select id from orders;', sampledParch);
    expect(verifySkipReason(steps, result, sampledParch)).toMatch(/sampled/);
  });

  it('does not skip when the query avoids sampled tables', () => {
    const { steps, result } = runQuery('select id from accounts;', sampledParch);
    expect(verifySkipReason(steps, result, sampledParch)).toBeNull();
  });

  it('skips LIMIT without ORDER BY (arbitrary row set)', () => {
    const { steps, result } = runQuery('select id from accounts limit 3;', parch);
    expect(verifySkipReason(steps, result, parch)).toMatch(/arbitrary/);
  });

  it('allows LIMIT with ORDER BY', () => {
    const { steps, result } = runQuery('select id from accounts order by id limit 3;', parch);
    expect(verifySkipReason(steps, result, parch)).toBeNull();
  });
});

describe('compareResults', () => {
  const { steps, result } = runQuery(
    'select id, name from accounts order by id limit 3;', parch,
  );

  it('matches identical results, tolerating Postgres numeric formatting', () => {
    // Postgres prints numeric columns with trailing zeros and text ids
    const v = compareResults(result, pg(['id', 'name'], [
      ['1001.000', 'Walmart'],
      ['1011', 'Exxon Mobil'],
      ['1021', 'Apple'],
    ]), hasTopLevelOrderBy(steps));
    expect(v.status).toBe('match');
  });

  it('reports differing cells with position and values', () => {
    const v = compareResults(result, pg(['id', 'name'], [
      ['1001', 'Walmart'],
      ['1011', 'Exxon'],
      ['1021', 'Apple'],
    ]), true);
    expect(v.status).toBe('differ');
    expect((v as { detail: string }).detail).toMatch(/row 2/);
  });

  it('reports row-count mismatches', () => {
    const v = compareResults(result, pg(['id', 'name'], [['1001', 'Walmart']]), true);
    expect(v.status).toBe('differ');
    expect((v as { detail: string }).detail).toMatch(/row counts/);
  });

  it('compares as a multiset when there is no top-level ORDER BY', () => {
    const { steps: s2, result: r2 } = runQuery('select id from region;', parch);
    const shuffled = [[4], [1], [7], [2], [6], [3], [5]] as PgQueryResult['rows'];
    const v = compareResults(r2, pg(['id'], shuffled), hasTopLevelOrderBy(s2));
    expect(v.status).toBe('match');
  });

  it('treats NULLs as equal to NULLs, not to empty strings', () => {
    const { steps: s3, result: r3 } = runQuery(
      "select nullif(name, name) as x from accounts where id = 1001;", parch,
    );
    expect(compareResults(r3, pg(['x'], [[null]]), hasTopLevelOrderBy(s3)).status).toBe('match');
    expect(compareResults(r3, pg(['x'], [['']]), hasTopLevelOrderBy(s3)).status).toBe('differ');
  });
});
