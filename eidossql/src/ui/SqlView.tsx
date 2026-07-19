// Read-only, syntax-highlighted SQL with the active-clause spotlight.
// Used by presentation mode (and the print layout), where the editable
// textarea would be clutter but the clause highlight still matters.

import { useMemo } from 'react';
import { buildSegments } from './highlight';

interface SqlViewProps {
  sql: string;
  highlight?: { start: number; end: number } | null;
}

export function SqlView({ sql, highlight }: SqlViewProps) {
  const segments = useMemo(() => buildSegments(sql, highlight), [sql, highlight]);
  return (
    <pre className="sql-view">
      <code>
        {segments.map((s, i) => (
          <span key={i} className={s.cls || undefined}>{s.text}</span>
        ))}
      </code>
    </pre>
  );
}
