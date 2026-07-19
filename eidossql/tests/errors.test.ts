// The teaching-error catalog — half the product is what EidosSQL says when a
// query is wrong. These tests pin every classic student mistake to its
// message and hint, so the pedagogy can't silently regress.

import { describe, it, expect } from 'vitest';
import { runQuery, SqlError } from '../src/engine';
import { parch } from '../src/data/datasets';

function errOf(sql: string): SqlError {
  try {
    runQuery(sql, parch);
  } catch (e) {
    if (e instanceof SqlError) return e;
    throw e;
  }
  throw new Error(`expected "${sql}" to fail, but it ran`);
}

describe('teaching errors', () => {
  it('SELECT alias used in WHERE explains clause order', () => {
    const e = errOf('select total as t from orders where t > 100;');
    expect(e.message).toMatch(/alias defined in SELECT/);
    expect(e.hint).toMatch(/runs \*before\* SELECT/);
  });

  it('aggregate in WHERE points to HAVING', () => {
    const e = errOf('select * from orders where sum(total) > 10;');
    expect(e.message).toMatch(/Aggregate functions are not allowed in WHERE/);
    expect(e.hint).toMatch(/HAVING/);
  });

  it('bare column with GROUP BY explains the group rule', () => {
    const e = errOf('select name, id from accounts group by name;');
    expect(e.message).toMatch(/"id" must appear in the GROUP BY clause or be used in an aggregate/);
    expect(e.hint).toMatch(/whole group/);
  });

  it('double-quoted text literal suggests single quotes', () => {
    const e = errOf(`select * from accounts where name = "Walmart";`);
    expect(e.message).toMatch(/Column "Walmart" does not exist/);
    expect(e.hint).toMatch(/single quotes/);
  });

  it('LEFT JOIN without ON explains cross-join blowup', () => {
    const e = errOf('select * from accounts a left join orders o;');
    expect(e.message).toMatch(/missing its ON condition/);
    expect(e.hint).toMatch(/every row pairs with every row/);
  });

  it('FROM subquery without alias explains why the name is needed', () => {
    const e = errOf('select * from (select 1);');
    expect(e.message).toMatch(/needs an alias/);
    expect(e.hint).toMatch(/AS sub/);
  });

  it('scalar subquery returning many rows suggests IN', () => {
    const e = errOf('select * from accounts where id = (select account_id from orders);');
    expect(e.message).toMatch(/used as a single value but returned \d+ rows/);
    expect(e.hint).toMatch(/IN \(subquery\)/);
  });

  it('nested aggregates suggest a CTE', () => {
    const e = errOf('select sum(count(*)) from orders;');
    expect(e.message).toMatch(/cannot be nested/);
    expect(e.hint).toMatch(/subquery or CTE/);
  });

  it('ambiguous column lists the candidates', () => {
    const e = errOf('select id from accounts a join sales_reps s on s.id = a.sales_rep_id;');
    expect(e.message).toMatch(/"id" is ambiguous/);
    expect(e.hint).toMatch(/Qualify it/);
  });

  it('unknown table lists what exists', () => {
    const e = errOf('select * from acount;');
    expect(e.message).toMatch(/Table "acount" does not exist/);
    expect(e.hint).toMatch(/accounts/);
  });

  it('unknown column lists available columns', () => {
    const e = errOf('select namee from accounts;');
    expect(e.message).toMatch(/"namee" does not exist/);
    expect(e.hint).toMatch(/Available columns/);
  });

  it('division by zero suggests NULLIF', () => {
    const e = errOf('select 1 / 0;');
    expect(e.message).toMatch(/division by zero/);
    expect(e.hint).toMatch(/NULLIF/);
  });

  it('window function in WHERE explains evaluation order', () => {
    const e = errOf('select * from orders where row_number() over () > 1;');
    expect(e.message).toMatch(/Window functions are not allowed in WHERE/);
  });

  it('window function without OVER names the fix', () => {
    const e = errOf('select rank() from accounts;');
    expect(e.message).toMatch(/needs an OVER/);
  });

  it('UNION column-count mismatch explains vertical stacking', () => {
    const e = errOf('select id from accounts union select id, name from accounts;');
    expect(e.message).toMatch(/same number of columns/);
    expect(e.hint).toMatch(/stack results vertically/);
  });

  it('WHERE after GROUP BY is caught with a word-order fix', () => {
    const e = errOf('select account_id from orders group by account_id where account_id > 1;');
    expect(e.message).toMatch(/WHERE cannot appear after GROUP BY/);
  });

  it('DISTINCT + ORDER BY on unselected column matches Postgres restriction', () => {
    const e = errOf('select distinct name from accounts order by id;');
    expect(e.message).toMatch(/must appear in the select list/);
  });

  it('errors carry a usable source span', () => {
    const sql = 'select total as t from orders where t > 100;';
    const e = errOf(sql);
    expect(e.start).toBeGreaterThan(0);
    expect(e.end).toBeGreaterThan(e.start);
    expect(sql.slice(e.start, e.end)).toBe('t');
  });
});
