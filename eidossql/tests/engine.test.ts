// Golden-result engine tests: a hand-checked subset of Postgres semantics
// that runs with no database, so `npm test` is meaningful anywhere. The full
// 61-query differential suite (npm run verify) remains the deep oracle.

import { describe, it, expect } from 'vitest';
import { runQuery } from '../src/engine';
import { parch } from '../src/data/datasets';

function cells(sql: string) {
  return runQuery(sql, parch).result.rows.map((r) => r.cells);
}

describe('Postgres semantics without Postgres', () => {
  it('integer division truncates; numeric does not', () => {
    expect(cells('select 7 / 2 as a, 7 / 2.0 as b, total / 2 as c from orders where id = 1;'))
      .toEqual([[3, 3.5, 84]]); // total = 169 → 84, not 84.5
  });

  it('aggregates over zero rows still return one row', () => {
    expect(cells('select count(*) as n, sum(total) as s from orders where id < 0;'))
      .toEqual([[0, null]]);
  });

  it('correlated count for an account with no orders is 0, not NULL', () => {
    expect(cells(`select a.name, (select count(*) from orders o where o.account_id = a.id) as n
                  from accounts a where a.name = 'Mattel';`))
      .toEqual([['Mattel', 0]]);
  });

  it('UNION dedupes; UNION ALL keeps duplicates', () => {
    const union = cells('select account_id from orders union select account_id from orders;');
    const all = cells('select account_id from orders union all select account_id from orders;');
    expect(union).toHaveLength(11);
    expect(all).toHaveLength(60);
  });

  it('running totals include peer rows (default RANGE frame)', () => {
    const rows = cells(`select account_id, sum(total) over (order by account_id) as rt
                        from orders where account_id in (1001, 1011);`);
    for (const [acct, rt] of rows) {
      expect(rt).toBe(acct === 1001 ? 1692 : 2233);
    }
  });

  it('NOT IN with a NULL in the list matches nothing (the classic trap)', () => {
    expect(cells(`select count(*) as n from accounts
                  where id not in (select sales_rep_id from sales_reps union select null);`))
      .toEqual([[0]]);
  });

  it('count(column) skips NULLs from a LEFT JOIN; count(*) does not', () => {
    expect(cells(`select count(o.id) as with_orders, count(*) as all_rows
                  from accounts a left join orders o on o.account_id = a.id;`))
      .toEqual([[30, 31]]);
  });

  it('DESC ordering puts NULLs first by default', () => {
    const rows = cells(`select o.id from accounts a
                        left join orders o on o.account_id = a.id
                        order by o.id desc;`);
    expect(rows[0][0]).toBeNull();
  });

  it('EXTRACT(hour) reads the interval component, not total hours', () => {
    expect(cells(`select extract(hour from (timestamp '2024-05-11 01:30:00'
                                          - timestamp '2024-05-10 00:00:00')) as h;`))
      .toEqual([[1]]); // 1 day 01:30 → hour component is 1, not 25
  });

  it('CASE falls through to ELSE and to NULL without one', () => {
    expect(cells(`select case when 1 = 2 then 'a' end as x,
                         case when 1 = 2 then 'a' else 'b' end as y;`))
      .toEqual([[null, 'b']]);
  });
});
