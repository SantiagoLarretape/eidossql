// Dialog for loading CSV files as a queryable dataset — one file per table,
// first row = column names, types inferred automatically.

import { useState } from 'react';
import { buildCsvDataset, csvToTable } from '../data/csv';
import type { Dataset, TableData } from '../data/datasets';

interface CsvPanelProps {
  onLoaded: (ds: Dataset) => void;
  onClose: () => void;
}

interface ParsedFile {
  fileName: string;
  table?: TableData;
  error?: string;
  text: string;
}

export function CsvPanel({ onLoaded, onClose }: CsvPanelProps) {
  const [files, setFiles] = useState<ParsedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (list: FileList | null) => {
    if (!list?.length) return;
    const next: ParsedFile[] = [];
    for (const f of Array.from(list)) {
      const text = await f.text();
      try {
        next.push({ fileName: f.name, table: csvToTable(f.name, text), text });
      } catch (err) {
        next.push({ fileName: f.name, error: (err as Error).message, text });
      }
    }
    setFiles((prev) => [...prev.filter((p) => !next.some((n) => n.fileName === p.fileName)), ...next]);
    setError(null);
  };

  const good = files.filter((f) => f.table);

  const create = () => {
    try {
      const ds = buildCsvDataset(good.map((f) => ({ name: f.fileName, text: f.text })));
      onLoaded(ds);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="connect-overlay" onClick={onClose}>
      <div className="connect-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="load CSV files">
        <h3>Load CSV files as tables</h3>
        <p className="connect-note">
          Each file becomes a table (named after the file). The first row must
          be column names; column types are detected automatically. Everything
          stays in your browser — nothing is uploaded anywhere.
        </p>
        <label className="connect-field">
          <span>CSV files</span>
          <input
            type="file"
            accept=".csv,text/csv"
            multiple
            onChange={(e) => onPick(e.target.files)}
          />
        </label>
        {files.length > 0 && (
          <ul className="csv-list">
            {files.map((f) => (
              <li key={f.fileName} className={f.error ? 'csv-bad' : ''}>
                <span className="csv-name">{f.fileName}</span>
                {f.table ? (
                  <span className="csv-meta">
                    → {f.table.name} · {f.table.rows.length.toLocaleString()} rows ·{' '}
                    {f.table.columns.length} cols
                  </span>
                ) : (
                  <span className="csv-meta">{f.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <div className="error-box" role="alert"><div className="error-title">{error}</div></div>}
        <div className="connect-actions">
          <button className="run-btn" onClick={create} disabled={good.length === 0}>
            Use {good.length || ''} table{good.length === 1 ? '' : 's'}
          </button>
          <button className="ghost-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
