// CSV ingestion: parsing edge cases and type inference.

import { describe, it, expect } from 'vitest';
import { parseCsv, csvToTable, buildCsvDataset } from '../src/data/csv';

describe('parseCsv', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\n')).toEqual([['a', 'b, c', 'say "hi"']]);
  });

  it('handles CRLF and a missing trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a\n"line1\nline2"\n')).toEqual([['a'], ['line1\nline2']]);
  });
});

describe('csvToTable', () => {
  it('infers integer / numeric / date / timestamp / boolean / text', () => {
    const t = csvToTable('demo.csv', [
      'id,score,signup,seen_at,active,note',
      '1,91.5,2024-01-15,2024-01-15 09:30:00,true,hello',
      '2,78,2024-02-20,2024-02-20 10:00,false,"x, y"',
    ].join('\n'));
    expect(t.columns.map((c) => c.type)).toEqual([
      'integer', 'numeric', 'date', 'timestamp', 'boolean', 'text',
    ]);
    expect(t.rows[0]).toEqual([1, 91.5, '2024-01-15', '2024-01-15 09:30:00', true, 'hello']);
    // hh:mm timestamps get seconds appended
    expect(t.rows[1][3]).toBe('2024-02-20 10:00:00');
  });

  it('turns blank cells into NULL without changing the column type', () => {
    const t = csvToTable('n.csv', 'x,y\n1,10\n2,\n3,30\n');
    expect(t.columns[1].type).toBe('integer');
    expect(t.rows.map((r) => r[1])).toEqual([10, null, 30]);
  });

  it('skips blank lines entirely (pandas-style)', () => {
    const t = csvToTable('n.csv', 'x\n1\n\n3\n');
    expect(t.rows.map((r) => r[0])).toEqual([1, 3]);
  });

  it('pads ragged rows and de-duplicates header names', () => {
    const t = csvToTable('r.csv', 'a,a,b\n1,2\n');
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'a_2', 'b']);
    expect(t.rows[0]).toEqual([1, 2, null]);
  });

  it('sanitizes the file name into a table name', () => {
    const t = csvToTable('My Data (v2).csv', 'a\n1\n');
    expect(t.name).toBe('my_data_v2');
  });

  it('rejects files without data rows', () => {
    expect(() => csvToTable('empty.csv', 'a,b\n')).toThrow(/no data rows/);
  });
});

describe('buildCsvDataset', () => {
  it('builds a dataset queryable by the engine', async () => {
    const ds = buildCsvDataset([{ name: 'pets.csv', text: 'name,age\nRex,4\nMochi,2\n' }]);
    const { runQuery } = await import('../src/engine');
    const { result } = runQuery('select name from pets where age > 3;', ds);
    expect(result.rows.map((r) => r.cells)).toEqual([['Rex']]);
  });

  it('rejects two files mapping to the same table name', () => {
    expect(() =>
      buildCsvDataset([
        { name: 'a b.csv', text: 'x\n1\n' },
        { name: 'a_b.csv', text: 'x\n1\n' },
      ]),
    ).toThrow(/same table name/);
  });
});
