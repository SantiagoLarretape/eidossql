import { describe, it, expect } from 'vitest';
import { runQuery } from '../src/engine';
import { parch } from '../src/data/datasets';

const ids = (sql: string) => runQuery(sql, parch).result.rows.map((r) => r.cells[0]);

describe('FETCH FIRST … ROWS ONLY (SQL-standard LIMIT)', () => {
  it('FETCH FIRST n ROWS ONLY matches LIMIT n', () => {
    expect(ids('select id from orders order by id fetch first 3 rows only;'))
      .toEqual(ids('select id from orders order by id limit 3;'));
  });
  it('FETCH NEXT with OFFSET n ROWS matches LIMIT/OFFSET', () => {
    expect(ids('select id from orders order by id offset 2 rows fetch next 2 rows only;'))
      .toEqual(ids('select id from orders order by id limit 2 offset 2;'));
  });
  it('FETCH FIRST ROW ONLY defaults to one row', () => {
    expect(ids('select id from orders order by id fetch first row only;')).toHaveLength(1);
  });
  it('rejects WITH TIES with a teaching message', () => {
    expect(() => runQuery('select id from orders order by id fetch first 3 rows with ties;', parch))
      .toThrow(/ONLY/);
  });
});
