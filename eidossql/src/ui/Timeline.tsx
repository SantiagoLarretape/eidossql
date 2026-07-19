// The step timeline: one chip per step, indented by nesting depth (CTE /
// subquery / set-op branch). Click to jump; the active chip auto-scrolls
// into view.
//
// Chips are tinted by the tables/CTEs/subqueries the step is working on —
// one wash for a single source, half-and-half for a join of two, stripes
// beyond that — so students can see "which table is this clause about"
// without re-reading the query. A legend appears whenever a query touches
// more than one source.

import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Step } from '../engine';

interface TimelineProps {
  steps: Step[];
  current: number;
  onSelect: (i: number) => void;
}

function chipBackground(sources: { name: string; color: number }[]): string {
  const segs = sources.slice(0, 4);
  const mix = (c: number) => `color-mix(in srgb, var(--g${c % 8}) 30%, var(--surface))`;
  if (segs.length === 1) return mix(segs[0].color);
  const n = segs.length;
  const stops = segs
    .map((s, i) => `${mix(s.color)} ${(i * 100) / n}% ${((i + 1) * 100) / n}%`)
    .join(', ');
  return `linear-gradient(105deg, ${stops})`;
}

export function Timeline({ steps, current, onSelect }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.querySelector('.chip-active');
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [current]);

  // legend: every distinct source across the run, in first-appearance order
  const legend = useMemo(() => {
    const seen = new Map<string, { name: string; color: number }>();
    for (const s of steps) {
      for (const src of s.sources ?? []) {
        const key = src.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, src);
      }
    }
    return [...seen.values()];
  }, [steps]);

  return (
    <div className="timeline-wrap">
      {legend.length >= 2 && (
        <div className="tl-legend" aria-label="tables in this query">
          {legend.map((s) => (
            <span key={s.name} className="tl-key">
              <span className="tl-swatch" style={{ background: `var(--g${s.color % 8})` }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="timeline" ref={ref} role="tablist" aria-label="query steps">
        {steps.map((s, i) => {
          const style: CSSProperties = { ['--depth' as string]: s.path.length };
          if (i !== current && s.sources?.length) {
            style.background = chipBackground(s.sources);
          }
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={i === current}
              className={[
                'chip',
                `chip-${s.phase}`,
                i === current ? 'chip-active' : '',
                i < current ? 'chip-done' : '',
                s.path.length > 0 ? 'chip-nested' : '',
              ].join(' ')}
              style={style}
              onClick={() => onSelect(i)}
              title={`${s.path.length ? s.path.join(' › ') + ' › ' : ''}${s.title}${
                s.sources?.length ? `\ntables: ${s.sources.map((x) => x.name).join(', ')}` : ''
              }`}
            >
              {s.path.length > 0 && <span className="chip-depth">{'›'.repeat(s.path.length)}</span>}
              {s.chip}
            </button>
          );
        })}
      </div>
    </div>
  );
}
