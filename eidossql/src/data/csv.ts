// CSV → Dataset: an RFC-4180-ish parser plus per-column type inference, so a
// professor can hand out plain CSV files and students can query them without
// touching Postgres.

import type { Dataset, TableData, ColumnDef, ColType } from './datasets';

/** Parse CSV text (quoted fields, escaped quotes, CRLF/LF, trailing newline). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      sawAny = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (sawAny || field !== '') {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      sawAny = false;
    } else {
      field += c;
      sawAny = true;
    }
  }
  if (sawAny || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const INT_RE = /^-?\d{1,15}$/;
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
const BOOL_RE = /^(true|false|t|f|yes|no)$/i;

function inferType(values: string[]): ColType {
  const nonEmpty = values.filter((v) => v.trim() !== '');
  if (nonEmpty.length === 0) return 'text';
  const all = (re: RegExp) => nonEmpty.every((v) => re.test(v.trim()));
  if (all(INT_RE)) return 'integer';
  if (all(NUM_RE)) return 'numeric';
  if (all(DATE_RE)) return 'date';
  if (all(TS_RE) || nonEmpty.every((v) => TS_RE.test(v.trim()) || DATE_RE.test(v.trim()))) return 'timestamp';
  if (all(BOOL_RE)) return 'boolean';
  return 'text';
}

function convert(raw: string, type: ColType): string | number | boolean | null {
  const v = raw.trim();
  if (v === '') return null;
  switch (type) {
    case 'integer': return parseInt(v, 10);
    case 'numeric': return parseFloat(v);
    case 'boolean': return /^(true|t|yes)$/i.test(v);
    case 'timestamp': {
      const t = v.replace('T', ' ');
      return TS_RE.test(v) ? (t.length === 16 ? `${t}:00` : t) : `${t} 00:00:00`;
    }
    case 'date': return v;
    default: return raw;
  }
}

function sanitizeName(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '');
  const clean = base.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return clean || 'table';
}

export function csvToTable(fileName: string, text: string): TableData {
  const grid = parseCsv(text);
  if (grid.length < 1 || grid[0].every((h) => h.trim() === '')) {
    throw new Error(`${fileName}: the first row must contain column names`);
  }
  const header = grid[0].map((h, i) => {
    const name = h.trim().replace(/\s+/g, '_') || `column_${i + 1}`;
    return name;
  });
  // de-duplicate header names
  const seen = new Map<string, number>();
  const names = header.map((h) => {
    const key = h.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });
  const width = names.length;
  // blank lines are skipped (pandas-style); blank *cells* become NULL
  const body = grid.slice(1).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (body.length === 0) throw new Error(`${fileName}: no data rows found`);
  const cells = body.map((r) => {
    const row = r.slice(0, width);
    while (row.length < width) row.push('');
    return row;
  });
  const columns: ColumnDef[] = names.map((name, ci) => ({
    name,
    type: inferType(cells.map((r) => r[ci])),
  }));
  const rows = cells.map((r) => r.map((v, ci) => convert(v, columns[ci].type)));
  return { name: sanitizeName(fileName), columns, rows };
}

export function buildCsvDataset(files: { name: string; text: string }[]): Dataset {
  const tables = files.map((f) => csvToTable(f.name, f.text));
  const dupes = new Set<string>();
  const used = new Set<string>();
  for (const t of tables) {
    if (used.has(t.name)) dupes.add(t.name);
    used.add(t.name);
  }
  if (dupes.size) {
    throw new Error(`Two files produce the same table name: ${[...dupes].join(', ')}. Rename one file.`);
  }
  return {
    id: 'csv',
    label: 'Uploaded CSVs',
    description: `Your uploaded files: ${tables.map((t) => t.name).join(', ')}.`,
    source: 'csv',
    tables,
  };
}
