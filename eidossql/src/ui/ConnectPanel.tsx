// Dialog for connecting EidosSQL to the student's own local Postgres
// database through the dev-server bridge.

import { useState } from 'react';
import { fetchPostgresDataset } from '../data/remote';
import type { Dataset } from '../data/datasets';

interface ConnectPanelProps {
  onConnected: (ds: Dataset, conn: string) => void;
  onClose: () => void;
}

// v2: default changed from a 300-row sample to "all rows" (exact results)
const LS_KEY = 'eidossql.pg.v2';

function savedPrefs(): { conn: string; limit: number } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { conn: 'postgres://localhost:5432/parch', limit: 0 };
}

export function ConnectPanel({ onConnected, onClose }: ConnectPanelProps) {
  const prefs = savedPrefs();
  const [conn, setConn] = useState(prefs.conn);
  const [limit, setLimit] = useState(prefs.limit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [omitted, setOmitted] = useState(0);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { dataset, tablesOmitted } = await fetchPostgresDataset(conn, limit);
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ conn, limit }));
      } catch { /* ignore */ }
      setOmitted(tablesOmitted);
      onConnected(dataset, conn);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-overlay" onClick={onClose}>
      <div className="connect-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="connect to Postgres">
        <h3>Connect your own Postgres database</h3>
        <p className="connect-note">
          Point EidosSQL at any database running on your machine — the same ones
          you use in DBeaver. The connection happens inside your local dev server;
          nothing ever leaves your computer.
        </p>
        <label className="connect-field">
          <span>Connection</span>
          <input
            value={conn}
            onChange={(e) => setConn(e.target.value)}
            placeholder="postgres://localhost:5432/parch  (or just: parch)"
            spellCheck={false}
            onKeyDown={(e) => e.key === 'Enter' && !busy && connect()}
          />
        </label>
        <p className="connect-hint">
          A bare name like <code>northwind</code> means{' '}
          <code>postgres://localhost:5432/northwind</code>. Add user/password if
          your server needs them: <code>postgres://user:pass@localhost:5432/db</code>
        </p>
        <label className="connect-field">
          <span>Rows per table</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            <option value={0}>all rows — exact results (recommended; up to 50,000/table)</option>
            <option value={10000}>first 10,000 (sample)</option>
            <option value={1000}>first 1,000 (sample)</option>
            <option value={300}>first 300 (sample)</option>
            <option value={100}>first 100 (sample)</option>
          </select>
        </label>
        <p className="connect-hint">
          With "all rows", every query's result matches the real database — and
          EidosSQL double-checks each run against your PostgreSQL (a ✓ appears on
          the result). Samples load faster for huge tables, but results on a
          sample can differ, so sampled tables are labeled and verification is off.
        </p>
        {error && <div className="error-box" role="alert"><div className="error-title">{error}</div></div>}
        {omitted > 0 && <div className="connect-hint">Note: only the first 40 tables were loaded ({omitted} omitted).</div>}
        <div className="connect-actions">
          <button className="run-btn" onClick={connect} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          <button className="ghost-btn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
