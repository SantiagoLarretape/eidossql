// SQL editor: a transparent <textarea> layered over a syntax-highlighted <pre>.
// The token layer doubles as the "clause spotlight": the SQL span belonging to
// the current visualization step gets a highlighted background, and parse
// errors get a wavy underline.

import { useRef, useEffect, useMemo } from 'react';
import { lex, KEYWORDS } from '../engine';
import type { Token } from '../engine';

interface Span {
  start: number;
  end: number;
}

interface EditorProps {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  highlight?: Span | null;
  errorSpan?: Span | null;
}

interface Segment {
  text: string;
  cls: string;
}

const FUNC_RE = /^[a-z_][a-z0-9_]*$/i;

function classify(t: Token, nextIsParen: boolean): string {
  switch (t.type) {
    case 'word':
      if (KEYWORDS.has(t.upper)) return 'tok-kw';
      if (nextIsParen && FUNC_RE.test(t.text)) return 'tok-fn';
      return 'tok-id';
    case 'qword': return 'tok-id';
    case 'num': return 'tok-num';
    case 'str': return 'tok-str';
    case 'comment': return 'tok-comment';
    case 'op': return 'tok-op';
    default: return 'tok-punct';
  }
}

function buildSegments(sql: string, active?: Span | null, err?: Span | null): Segment[] {
  // token classification (never throws: fall back to plain text)
  let toks: Token[] = [];
  try {
    toks = lex(sql, true);
  } catch {
    toks = [];
  }
  // char-class array approach: simple and robust for editor-sized inputs
  const cls = new Array<string>(sql.length).fill('');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'eof') break;
    const next = toks[i + 1];
    const c = classify(t, !!next && next.text === '(');
    for (let j = t.start; j < t.end && j < sql.length; j++) cls[j] = c;
  }
  const inSpan = (j: number, s?: Span | null) => !!s && j >= s.start && j < Math.max(s.end, s.start + 1);
  const segs: Segment[] = [];
  let cur = '';
  let curCls: string | null = null;
  for (let j = 0; j < sql.length; j++) {
    const c = `${cls[j]}${inSpan(j, active) ? ' hl-active' : ''}${inSpan(j, err) ? ' hl-err' : ''}`;
    if (c !== curCls) {
      if (cur) segs.push({ text: cur, cls: curCls! });
      cur = '';
      curCls = c;
    }
    cur += sql[j];
  }
  if (cur) segs.push({ text: cur, cls: curCls! });
  return segs;
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
