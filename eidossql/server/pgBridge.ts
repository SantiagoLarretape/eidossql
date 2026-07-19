// Local Postgres bridge — a Vite dev/preview middleware.
//
// Browsers can't speak the Postgres wire protocol, so when a student wants to
// point EidosSQL at their own database, the request goes to this tiny
// endpoint *inside their own dev server*, which connects to the database,
// introspects the public schema, and returns a row sample shaped like the
// app's embedded datasets. Everything stays on the student's machine —
// the connection string is never stored and never leaves localhost.
//
// Single endpoint:
//   POST /api/pg/snapshot  { conn: string, limit: number }
//   → { dbName, tables: [{ name, totalRows, columns: [{name, type}], rows }] }

import type { Plugin, Connect } from 'vite';
import pg from 'pg';

const { Client, types } = pg;

// Return dates/timestamps as raw strings, numbers as numbers.
types.setTypeParser(1082, (v: string) => v); // date
types.setTypeParser(1114, (v: string) => v); // timestamp
types.setTypeParser(1184, (v: string) => v); // timestamptz
types.setTypeParser(1700, (v: string) => parseFloat(v)); // numeric
types.setTypeParser(20, (v: string) => parseInt(v, 10)); // int8
types.setTypeParser(700, (v: string) => parseFloat(v)); // float4
types.setTypeParser(701, (v: string) => parseFloat(v)); // float8

const MAX_TABLES = 40;
const MAX_LIMIT = 50_000;

type ColType = 'integer' | 'numeric' | 'text' | 'timestamp' | 'date' | 'boolean';

function mapType(dataType: string): ColType {
  const t = dataType.toLowerCase();
  if (['smallint', 'integer', 'bigint'].includes(t)) return 'integer';
  if (['numeric', 'decimal', 'real', 'double precision', 'money'].includes(t)) return 'numeric';
  if (t === 'date') return 'date';
  if (t.startsWith('timestamp')) return 'timestamp';
  if (t === 'boolean') return 'boolean';
  return 'text';
}

/** Normalize a cell into the engine's value space. */
function normCell(v: unknown, type: ColType): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (type === 'timestamp' && typeof v === 'string') {
    // "2024-05-10T11:30:00.123+02" / "2024-05-10 11:30:00.123+02" → "2024-05-10 11:30:00"
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(v);
    return m ? `${m[1]} ${m[2]}` : String(v);
  }
  if (type === 'date' && typeof v === 'string') return v.slice(0, 10);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return String(v); // json, uuid objects, etc.
}

function normalizeConn(raw: string): string {
  const s = raw.trim();
  if (s.includes('://')) return s;
  // bare database name → local default
  return `postgres://localhost:5432/${s}`;
}

async function snapshot(connRaw: string, limitRaw: number) {
  // limit 0 (or anything non-positive/invalid) means "all rows", hard-capped
  const n = Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 300;
  const limit = n <= 0 ? MAX_LIMIT : Math.min(MAX_LIMIT, n);
  const client = new Client({
    connectionString: normalizeConn(connRaw),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const tablesRes = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    );
    const allNames: string[] = tablesRes.rows.map((r) => r.table_name);
    const names = allNames.slice(0, MAX_TABLES);
    const colsRes = await client.query(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public'
       order by table_name, ordinal_position`,
    );
    const colsByTable = new Map<string, { name: string; type: ColType }[]>();
    for (const r of colsRes.rows) {
      if (!colsByTable.has(r.table_name)) colsByTable.set(r.table_name, []);
      colsByTable.get(r.table_name)!.push({ name: r.column_name, type: mapType(r.data_type) });
    }
    const tables = [];
    for (const name of names) {
      const columns = colsByTable.get(name) ?? [];
      const qname = `"${name.replace(/"/g, '""')}"`;
      const countRes = await client.query(`select count(*)::bigint as n from ${qname}`);
      const totalRows = Number(countRes.rows[0].n);
      const colList = columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ');
      const rowsRes = await client.query(`select ${colList} from ${qname} limit ${limit}`);
      const rows = rowsRes.rows.map((r: Record<string, unknown>) =>
        columns.map((c) => normCell(r[c.name], c.type)),
      );
      tables.push({ name, totalRows, columns, rows });
    }
    return {
      dbName: client.database ?? 'postgres',
      tables,
      tablesOmitted: Math.max(0, allNames.length - names.length),
    };
  } finally {
    await client.end();
  }
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('request too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function middleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (req.url !== '/api/pg/snapshot' || req.method !== 'POST') return next();
    res.setHeader('Content-Type', 'application/json');
    try {
      const body = JSON.parse(await readBody(req));
      const result = await snapshot(String(body.conn ?? ''), Number(body.limit));
      res.statusCode = 200;
      res.end(JSON.stringify(result));
    } catch (err) {
      res.statusCode = 400;
      const e = err as Error & { code?: string };
      let message = e.message || 'connection failed';
      if (e.code === 'ECONNREFUSED') {
        message = 'Could not reach Postgres — is the server running on that host/port?';
      } else if (e.code === '3D000') {
        message = `That database does not exist. ${message}`;
      } else if (e.code === '28P01' || e.code === '28000') {
        message = `Authentication failed. ${message}`;
      }
      res.end(JSON.stringify({ error: message }));
    }
  };
}

export function pgBridge(): Plugin {
  return {
    name: 'eidossql-pg-bridge',
    configureServer(server) {
      server.middlewares.use(middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware());
    },
  };
}
