// Collapsible schema reference for the active dataset.

import type { Dataset } from '../data/datasets';

const TYPE_LABEL: Record<string, string> = {
  integer: '123',
  numeric: '1.5',
  text: 'abc',
  timestamp: '🕐',
  date: '📅',
  boolean: 'T/F',
};

export function SchemaPanel({ dataset }: { dataset: Dataset }) {
  return (
    <div className="schema">
      <div className="schema-head">Schema · {dataset.label}</div>
      <p className="schema-desc">{dataset.description}</p>
      {dataset.tables.map((t) => (
        <details key={t.name} className="schema-table">
          <summary>
            <span className="schema-tname">{t.name}</span>
            <span className="schema-count">
              {t.totalRows
                ? `${t.rows.length.toLocaleString()} of ${t.totalRows.toLocaleString()} rows (sample)`
                : `${t.rows.length} rows`}
            </span>
          </summary>
          <ul>
            {t.columns.map((c) => (
              <li key={c.name}>
                <span className="schema-type" title={c.type}>{TYPE_LABEL[c.type] ?? '?'}</span>
                <span className="schema-cname">{c.name}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
