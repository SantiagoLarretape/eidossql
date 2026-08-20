// The animated table: rows keep stable keys across steps, so framer-motion's
// layout animations show each row's journey — reordering (ORDER BY), removal
// (WHERE/HAVING/LIMIT), appearance (JOIN NULL-fills, computed columns), and
// group/partition membership (color washes).

import { motion, AnimatePresence } from 'framer-motion';
import type { VizTable, VizRow } from '../engine';
import { formatValue } from '../engine';

const GLYPHS: Record<string, string> = {
  kept: '✓',
  dropped: '✕',
  new: '+',
};

function rowTitle(r: VizRow): string | undefined {
  switch (r.status) {
    case 'kept': return 'passes this step';
    case 'dropped': return 'removed at this step';
    case 'new': return 'appears at this step';
    default: return undefined;
  }
}

export function StepTable({ table }: { table: VizTable }) {
  const hasNotes = table.rows.some((r) => r.note);
  const hasStatus = table.rows.some((r) => r.status !== 'normal');
  const numericCols = table.columns.map((_, ci) =>
    table.rows.some((r) => typeof r.cells[ci] === 'number'),
  );
  // very large tables (the final-result view) render statically — FLIP
  // animations on a thousand rows would only burn CPU
  const animated = table.rows.length <= 150;

  const rowClass = (r: VizRow) =>
    [`row-${r.status}`, r.group !== undefined ? `grp grp-${r.group % 8}` : ''].join(' ');

  const cells = (r: VizRow) => (
    <>
      {hasStatus && (
        <td className="col-glyph">
          <span className={`glyph glyph-${r.status}`}>{GLYPHS[r.status] ?? ''}</span>
        </td>
      )}
      {r.cells.map((v, ci) => (
        <td key={table.columns[ci]?.id ?? ci} className={numericCols[ci] ? 'num' : undefined}>
          {v === null ? <span className="null">NULL</span> : formatValue(v)}
        </td>
      ))}
      {hasNotes && (
        <td className="col-note">
          {r.note && <span className={`note-pill note-${r.status}`}>{r.note}</span>}
        </td>
      )}
    </>
  );

  return (
    <div className="tbl-scroll">
      <table className="viz-table">
        <thead>
          <tr>
            {hasStatus && <th className="col-glyph" aria-label="row status" />}
            {table.columns.map((c) => (
              <th key={c.id} className={`col-${c.status}`}>
                {c.source && <span className="col-src">{c.source}</span>}
                <span className="col-name">{c.label}</span>
              </th>
            ))}
            {hasNotes && <th className="col-note" aria-label="notes" />}
          </tr>
        </thead>
        <tbody>
          {animated ? (
            <AnimatePresence initial={false}>
              {table.rows.map((r) => (
                <motion.tr
                  key={r.id}
                  layout="position"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    // rows *travel* on reorder/removal — slow enough to read
                    // as movement, not a teleport-and-recolor
                    layout: { duration: 0.55, ease: [0.4, 0, 0.2, 1] },
                    opacity: { duration: 0.35, ease: 'easeOut' },
                    y: { duration: 0.4, ease: 'easeOut' },
                  }}
                  className={rowClass(r)}
                  title={rowTitle(r)}
                >
                  {cells(r)}
                </motion.tr>
              ))}
            </AnimatePresence>
          ) : (
            table.rows.map((r) => (
              <tr key={r.id} className={rowClass(r)} title={rowTitle(r)}>
                {cells(r)}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {table.truncated ? (
        <div className="truncated">… {table.truncated} more row{table.truncated === 1 ? '' : 's'} not shown</div>
      ) : null}
      {table.rows.length === 0 && <div className="empty-table">no rows</div>}
    </div>
  );
}
