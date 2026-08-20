// Client for the local Postgres bridge (see server/pgBridge.ts).

import type { Dataset } from './datasets';
import type { PgQueryResult } from './liveVerify';

export interface ConnectResult {
  dataset: Dataset;
  tablesOmitted: number;
}

/** Run one query against the connected database (used for live verification). */
export async function runPostgresQuery(conn: string, sql: string): Promise<PgQueryResult> {
  const res = await fetch('/api/pg/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conn, sql }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error ?? `bridge error (${res.status})`);
  return body as PgQueryResult;
}

export async function fetchPostgresDataset(conn: string, limit: number): Promise<ConnectResult> {
  let res: Response;
  try {
    res = await fetch('/api/pg/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conn, limit }),
    });
  } catch {
    throw new Error(
      'The local database bridge is not reachable. Connecting to your own Postgres only works when EidosSQL is running locally (npm run dev).',
    );
  }
  if (res.status === 404) {
    throw new Error(
      'The local database bridge is not available on this server. Run EidosSQL locally with npm run dev to connect your own database.',
    );
  }
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `Bridge error (${res.status})`);
  }
  const dataset: Dataset = {
    id: `pg:${body.dbName}`,
    label: `${body.dbName} (your Postgres)`,
    description: `Live snapshot of your local "${body.dbName}" database.`,
    source: 'postgres',
    tables: body.tables.map((t: {
      name: string;
      totalRows: number;
      columns: { name: string; type: string }[];
      rows: (string | number | boolean | null)[][];
    }) => ({
      name: t.name,
      columns: t.columns,
      rows: t.rows,
      totalRows: t.totalRows > t.rows.length ? t.totalRows : undefined,
    })),
  };
  if (dataset.tables.length === 0) {
    throw new Error('Connected, but found no tables in the public schema of that database.');
  }
  return { dataset, tablesOmitted: body.tablesOmitted ?? 0 };
}
