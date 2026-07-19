// SQL tokenizer. Produces tokens with source positions; also used by the
// editor for syntax highlighting (with comments kept).

export class SqlError extends Error {
  start: number;
  end: number;
  hint?: string;
  constructor(message: string, start: number, end: number, hint?: string) {
    super(message);
    this.name = 'SqlError';
    this.start = start;
    this.end = end;
    this.hint = hint;
  }
}

export type TokType = 'word' | 'qword' | 'num' | 'str' | 'op' | 'punct' | 'comment' | 'eof';

export interface Token {
  type: TokType;
  text: string;
  /** Uppercased text for keyword matching (words only). */
  upper: string;
  start: number;
  end: number;
}

export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'AS', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'IN', 'IS', 'LIKE', 'ILIKE',
  'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'JOIN', 'INNER', 'LEFT',
  'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING', 'UNION', 'ALL', 'INTERSECT',
  'EXCEPT', 'DISTINCT', 'WITH', 'EXISTS', 'EXTRACT', 'CAST', 'OVER', 'PARTITION',
  'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'INTERVAL', 'ROWS', 'UNBOUNDED',
  'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'DATE', 'TIMESTAMP',
]);

const OPS = ['<>', '!=', '<=', '>=', '||', '::', '=', '<', '>', '+', '-', '*', '/', '%'];

export function lex(sql: string, keepComments = false): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // -- line comment
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      if (keepComments) toks.push({ type: 'comment', text: sql.slice(start, i), upper: '', start, end: i });
      continue;
    }
    // /* block comment */
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i >= n) throw new SqlError('Unterminated /* comment', start, n);
      i += 2;
      if (keepComments) toks.push({ type: 'comment', text: sql.slice(start, i), upper: '', start, end: i });
      continue;
    }
    // string literal
    if (c === "'") {
      const start = i;
      i++;
      let val = '';
      for (;;) {
        if (i >= n) throw new SqlError('Unterminated string — missing closing quote (\')', start, n);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            val += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          val += sql[i];
          i++;
        }
      }
      toks.push({ type: 'str', text: val, upper: '', start, end: i });
      continue;
    }
    // quoted identifier
    if (c === '"') {
      const start = i;
      i++;
      let val = '';
      while (i < n && sql[i] !== '"') {
        val += sql[i];
        i++;
      }
      if (i >= n) throw new SqlError('Unterminated quoted identifier', start, n);
      i++;
      toks.push({ type: 'qword', text: val, upper: val.toUpperCase(), start, end: i });
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9]/.test(sql[i])) i++;
      if (sql[i] === '.' && /[0-9]/.test(sql[i + 1] ?? '')) {
        i++;
        while (i < n && /[0-9]/.test(sql[i])) i++;
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        let j = i + 1;
        if (sql[j] === '+' || sql[j] === '-') j++;
        if (/[0-9]/.test(sql[j] ?? '')) {
          i = j;
          while (i < n && /[0-9]/.test(sql[i])) i++;
        }
      }
      toks.push({ type: 'num', text: sql.slice(start, i), upper: '', start, end: i });
      continue;
    }
    // word / identifier
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      const text = sql.slice(start, i);
      toks.push({ type: 'word', text, upper: text.toUpperCase(), start, end: i });
      continue;
    }
    // operators
    const two = sql.slice(i, i + 2);
    const op = OPS.find((o) => (o.length === 2 ? o === two : o === c));
    if (op) {
      toks.push({ type: 'op', text: op, upper: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }
    if ('(),.;'.includes(c)) {
      toks.push({ type: 'punct', text: c, upper: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new SqlError(`Unexpected character '${c}'`, i, i + 1);
  }
  toks.push({ type: 'eof', text: '', upper: '', start: n, end: n });
  return toks;
}
