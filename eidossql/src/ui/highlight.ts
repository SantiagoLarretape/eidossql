// Shared syntax-highlighting segment builder — used by the Editor overlay,
// the read-only SqlView (presentation/print), and nothing else. Built on the
// engine's own tokenizer so the editor and engine can never disagree.

import { lex, KEYWORDS } from '../engine';
import type { Token } from '../engine';

export interface Span {
  start: number;
  end: number;
}

export interface Segment {
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

export function buildSegments(sql: string, active?: Span | null, err?: Span | null): Segment[] {
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
