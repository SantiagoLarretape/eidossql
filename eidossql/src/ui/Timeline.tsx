// The step timeline: one chip per step, indented by nesting depth (CTE /
// subquery / set-op branch). Click to jump; the active chip auto-scrolls
// into view.

import { useEffect, useRef } from 'react';
import type { Step } from '../engine';

interface TimelineProps {
  steps: Step[];
  current: number;
  onSelect: (i: number) => void;
}

export function Timeline({ steps, current, onSelect }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.querySelector('.chip-active');
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [current]);

  return (
    <div className="timeline" ref={ref} role="tablist" aria-label="query steps">
      {steps.map((s, i) => (
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
          style={{ ['--depth' as string]: s.path.length }}
          onClick={() => onSelect(i)}
          title={`${s.path.length ? s.path.join(' › ') + ' › ' : ''}${s.title}`}
        >
          {s.path.length > 0 && <span className="chip-depth">{'›'.repeat(s.path.length)}</span>}
          {s.chip}
        </button>
      ))}
    </div>
  );
}
