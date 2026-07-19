// Step descriptions with count-up numbers: integers tick from 0 to their
// value in ~0.5s, drawing the eye to the row counts — the pedagogical
// payload of each step. Decimals and reduced-motion users get static text.

import { useEffect, useRef, useState } from 'react';

const NUM_RE = /(\d[\d,]*(?:\.\d+)?)/g;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function CountNum({ raw }: { raw: string }) {
  const isDecimal = raw.includes('.');
  const target = parseInt(raw.replace(/,/g, ''), 10);
  const skip = isDecimal || isNaN(target) || target === 0 || prefersReducedMotion();
  const [done, setDone] = useState(skip);
  const [shown, setShown] = useState(skip ? raw : '0');
  const rafRef = useRef(0);

  useEffect(() => {
    if (skip) return;
    const t0 = performance.now();
    const dur = 500;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p >= 1) {
        setShown(raw); // exact original formatting at the end
        setDone(true);
      } else {
        setShown(Math.round(target * eased).toLocaleString('en-US'));
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <span className={done ? undefined : 'counting'}>{shown}</span>;
}

export function AnimatedDesc({ text }: { text: string }) {
  const parts = text.split(NUM_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <CountNum key={i} raw={p} /> : <span key={i}>{p}</span>,
      )}
    </>
  );
}
