// SQL editor: a transparent <textarea> layered over a syntax-highlighted <pre>.
// The token layer doubles as the "clause spotlight": the SQL span belonging to
// the current visualization step gets a highlighted background, and parse
// errors get a wavy underline.

import { useRef, useEffect, useMemo } from 'react';
import { buildSegments } from './highlight';
import type { Span } from './highlight';

interface EditorProps {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  highlight?: Span | null;
  errorSpan?: Span | null;
}

export function Editor({ value, onChange, onRun, highlight, errorSpan }: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const segments = useMemo(
    () => buildSegments(value, highlight, errorSpan),
    [value, highlight, errorSpan],
  );

  const syncScroll = () => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  // keep the active clause visible when stepping
  useEffect(() => {
    if (!highlight || !preRef.current || !taRef.current) return;
    const mark = preRef.current.querySelector('.hl-active');
    if (mark instanceof HTMLElement) {
      const pre = preRef.current;
      const top = mark.offsetTop;
      if (top < pre.scrollTop + 8 || top > pre.scrollTop + pre.clientHeight - 28) {
        const target = Math.max(0, top - pre.clientHeight / 2);
        taRef.current.scrollTop = target;
        pre.scrollTop = target;
      }
    }
  }, [highlight]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = taRef.current!;
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = value.slice(0, s) + '  ' + value.slice(en);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  return (
    <div className="editor">
      <pre ref={preRef} className="editor-layer" aria-hidden="true">
        <code>
          {segments.map((s, i) => (
            <span key={i} className={s.cls || undefined}>{s.text}</span>
          ))}
          {'\n'}
        </code>
      </pre>
      <textarea
        ref={taRef}
        className="editor-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label="SQL query editor"
      />
    </div>
  );
}
