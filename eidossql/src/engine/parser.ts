// Recursive-descent parser for the course SQL subset (Postgres-flavored).
// Produces AST nodes with source spans; errors carry positions and, where a
// mistake is common among students, a teaching hint.

import { lex, SqlError, KEYWORDS } from './tokens';
import type { Token } from './tokens';
import type {
  Query, QueryBody, SelectCore, SetOp, Cte, SelectItem, TableRef, Join, JoinType,
  Expr, OrderItem, WindowSpec, FrameBound, ColRef, StarRef, Span,
} from './ast';

/** Keyword-named functions that may still be called with parens. */
const FUNC_KEYWORDS = new Set(['LEFT', 'RIGHT']);

/** Words that end an implicit (no-AS) alias. */
function canBeBareAlias(t: Token): boolean {
  return (t.type === 'word' && !KEYWORDS.has(t.upper)) || t.type === 'qword';
}

export function parse(sql: string): Query {
  return new Parser(sql).parseStatement();
}

class Parser {
  sql: string;
  toks: Token[];
  pos = 0;

  constructor(sql: string) {
    this.sql = sql;
    this.toks = lex(sql);
  }

  // ---------- token helpers ----------

  peek(offset = 0): Token {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)];
  }
  next(): Token {
    return this.toks[this.pos++];
  }
  isWord(kw: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'word' && t.upper === kw;
  }
  isPunct(p: string, offset = 0): boolean {
    const t = this.peek(offset);
    return (t.type === 'punct' || t.type === 'op') && t.text === p;
  }
  matchWord(...kws: string[]): Token | null {
    const t = this.peek();
    if (t.type === 'word' && kws.includes(t.upper)) return this.next();
    return null;
  }
  expectWord(kw: string, context?: string): Token {
    const t = this.peek();
    if (t.type === 'word' && t.upper === kw) return this.next();
    throw this.err(`Expected ${kw}${context ? ` ${context}` : ''}, found ${this.describe(t)}`, t);
  }
  expectPunct(p: string, context?: string): Token {
    const t = this.peek();
    if ((t.type === 'punct' || t.type === 'op') && t.text === p) return this.next();
    throw this.err(`Expected '${p}'${context ? ` ${context}` : ''}, found ${this.describe(t)}`, t);
  }
  describe(t: Token): string {
    if (t.type === 'eof') return 'end of query';
    if (t.type === 'str') return `text value '${t.text}'`;
    return `'${t.text}'`;
  }
  err(message: string, t: Token, hint?: string): SqlError {
    return new SqlError(message, t.start, t.end, hint);
  }

  /** Expect an identifier (table/column/alias name). */
  expectName(what: string): { name: string; quoted: boolean; tok: Token } {
    const t = this.peek();
    if (t.type === 'qword') {
      this.next();
      return { name: t.text, quoted: true, tok: t };
    }
    if (t.type === 'word') {
      if (KEYWORDS.has(t.upper)) {
        throw this.err(
          `Expected ${what}, but '${t.text}' is a SQL keyword`, t,
          `If you really have a ${what} named "${t.text}", wrap it in double quotes.`,
        );
      }
      this.next();
      return { name: t.text, quoted: false, tok: t };
    }
    throw this.err(`Expected ${what}, found ${this.describe(t)}`, t);
  }

  // ---------- statement / query ----------

  parseStatement(): Query {
    const q = this.parseQueryFull();
    if (this.isPunct(';')) this.next();
    const t = this.peek();
    if (t.type !== 'eof') {
      throw this.err(`Unexpected ${this.describe(t)} after the end of the query`, t,
        'Only a single SELECT statement can be visualized at a time.');
    }
    return q;
  }

  parseQueryFull(): Query {
    const startTok = this.peek();
    const ctes: Cte[] = [];
    let withSpan: Span | undefined;

    if (this.isWord('WITH')) {
      const withTok = this.next();
      for (;;) {
        const { name, tok } = this.expectName('CTE name');
        let columns: string[] | undefined;
        if (this.isPunct('(')) {
          // optional column list: WITH months(mnum, mname) AS (…)
          this.next();
          columns = [];
          for (;;) {
            columns.push(this.expectName('CTE column name').name);
            if (this.isPunct(',')) {
              this.next();
              continue;
            }
            break;
          }
          this.expectPunct(')', 'to close the CTE column list');
        }
        this.expectWord('AS', 'after the CTE name');
        this.expectPunct('(', 'to open the CTE definition');
        const sub = this.parseQueryFull();
        const close = this.expectPunct(')', 'to close the CTE definition');
        ctes.push({ name, columns, query: sub, start: tok.start, end: close.end });
        if (this.isPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
      withSpan = { start: withTok.start, end: ctes[ctes.length - 1].end };
    }

    const body = this.parseSetExpr();

    let orderBy: OrderItem[] | undefined;
    let orderSpan: Span | undefined;
    if (this.isWord('ORDER')) {
      const oTok = this.next();
      this.expectWord('BY', "after ORDER");
      orderBy = this.parseOrderItems();
      orderSpan = { start: oTok.start, end: orderBy[orderBy.length - 1].end };
    }

    let limit: number | undefined;
    let offset: number | undefined;
    let limitSpan: Span | undefined;
    if (this.isWord('LIMIT')) {
      const lTok = this.next();
      if (this.matchWord('ALL')) {
        limit = undefined;
      } else {
        const t = this.peek();
        if (t.type !== 'num') throw this.err('LIMIT expects a number', t);
        this.next();
        limit = parseInt(t.text, 10);
      }
      limitSpan = { start: lTok.start, end: this.peek(-1) ? this.toks[this.pos - 1].end : lTok.end };
    }
    if (this.isWord('OFFSET')) {
      const oTok = this.next();
      const t = this.peek();
      if (t.type !== 'num') throw this.err('OFFSET expects a number', t);
      this.next();
      offset = parseInt(t.text, 10);
      // SQL-standard spelling: OFFSET n ROWS
      if (this.isWord('ROW') || this.isWord('ROWS')) this.next();
      limitSpan = { start: limitSpan?.start ?? oTok.start, end: this.toks[this.pos - 1].end };
    }
    // SQL-standard alternative to LIMIT: FETCH { FIRST | NEXT } [ n ] { ROW | ROWS } ONLY
    if (this.isWord('FETCH')) {
      const fTok = this.next();
      if (limit !== undefined) throw this.err('Use either LIMIT or FETCH FIRST, not both', fTok);
      if (!this.matchWord('FIRST') && !this.matchWord('NEXT')) {
        throw this.err("FETCH must be followed by FIRST or NEXT (e.g. FETCH FIRST 10 ROWS ONLY)", this.peek());
      }
      let n = 1;
      if (this.peek().type === 'num') n = parseInt(this.next().text, 10);
      if (!this.matchWord('ROWS') && !this.matchWord('ROW')) {
        throw this.err("Expected ROWS after the count (e.g. FETCH FIRST 10 ROWS ONLY)", this.peek());
      }
      if (!this.matchWord('ONLY')) {
        throw this.err("FETCH FIRST … must end with ONLY (WITH TIES is not supported here)", this.peek());
      }
      limit = n;
      limitSpan = { start: limitSpan?.start ?? fTok.start, end: this.toks[this.pos - 1].end };
    }

    const endTok = this.toks[this.pos - 1] ?? startTok;
    return {
      kind: 'query', ctes, body, orderBy, limit, offset,
      withSpan, orderSpan, limitSpan,
      start: startTok.start, end: endTok.end,
    };
  }

  /** UNION / EXCEPT level (INTERSECT binds tighter, as in Postgres). */
  parseSetExpr(): QueryBody {
    let left = this.parseSetTerm();
    for (;;) {
      if (this.isWord('UNION') || this.isWord('EXCEPT')) {
        const opTok = this.next();
        let op: SetOp['op'] = opTok.upper === 'UNION' ? 'union' : 'except';
        let opEnd = opTok.end;
        if (opTok.upper === 'UNION' && this.isWord('ALL')) {
          opEnd = this.next().end;
          op = 'unionAll';
        }
        const right = this.parseSetTerm();
        left = {
          kind: 'setop', op, left, right,
          opSpan: { start: opTok.start, end: opEnd },
          start: (left as Span).start, end: (right as Span).end,
        };
      } else break;
    }
    return left;
  }

  parseSetTerm(): QueryBody {
    let left = this.parseSetPrimary();
    while (this.isWord('INTERSECT')) {
      const opTok = this.next();
      const right = this.parseSetPrimary();
      left = {
        kind: 'setop', op: 'intersect', left, right,
        opSpan: { start: opTok.start, end: opTok.end },
        start: (left as Span).start, end: (right as Span).end,
      };
    }
    return left;
  }

  parseSetPrimary(): QueryBody {
    if (this.isPunct('(') && (this.isWord('SELECT', 1) || this.isWord('WITH', 1) || this.isWord('VALUES', 1) || this.isPunct('(', 1))) {
      this.next();
      const q = this.parseQueryFull();
      this.expectPunct(')', 'to close the parenthesized query');
      return q;
    }
    if (this.isWord('VALUES')) return this.parseValues();
    if (this.isWord('SELECT')) return this.parseSelectCore();
    const t = this.peek();
    throw this.err(`Expected SELECT, found ${this.describe(t)}`, t,
      'Every query (or set-operation branch) must start with SELECT, WITH, VALUES, or an opening parenthesis.');
  }

  parseValues(): QueryBody {
    const vTok = this.expectWord('VALUES');
    const rows: Expr[][] = [];
    for (;;) {
      this.expectPunct('(', 'to open a VALUES row');
      const row: Expr[] = [];
      for (;;) {
        row.push(this.parseExpr());
        if (this.isPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
      this.expectPunct(')', 'to close the VALUES row');
      if (rows.length && row.length !== rows[0].length) {
        throw this.err(
          `Every VALUES row must have the same number of values (this one has ${row.length}, the first has ${rows[0].length})`,
          this.toks[this.pos - 1],
        );
      }
      rows.push(row);
      if (this.isPunct(',')) {
        this.next();
        continue;
      }
      break;
    }
    return { kind: 'values', rows, start: vTok.start, end: this.toks[this.pos - 1].end };
  }

  // ---------- select core ----------

  parseSelectCore(): SelectCore {
    const selTok = this.expectWord('SELECT');
    let distinct = false;
    if (this.matchWord('DISTINCT')) distinct = true;
    else this.matchWord('ALL');

    const items: SelectItem[] = [];
    for (;;) {
      items.push(this.parseSelectItem());
      if (this.isPunct(',')) {
        this.next();
        continue;
      }
      break;
    }
    const selectSpan = { start: selTok.start, end: items[items.length - 1].end };

    let from: SelectCore['from'];
    let fromSpan: Span | undefined;
    if (this.isWord('FROM')) {
      const fromTok = this.next();
      const base = this.parseTableRef();
      fromSpan = { start: fromTok.start, end: base.end };
      const joins: Join[] = [];
      for (;;) {
        const join = this.tryParseJoin();
        if (!join) break;
        joins.push(join);
      }
      from = { base, joins };
    }

    let where: Expr | undefined;
    let whereSpan: Span | undefined;
    if (this.isWord('WHERE')) {
      const wTok = this.next();
      where = this.parseExpr();
      whereSpan = { start: wTok.start, end: where.end };
    }

    let groupBy: Expr[] | undefined;
    let groupSpan: Span | undefined;
    if (this.isWord('GROUP')) {
      const gTok = this.next();
      this.expectWord('BY', 'after GROUP');
      groupBy = [];
      for (;;) {
        groupBy.push(this.parseExpr());
        if (this.isPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
      groupSpan = { start: gTok.start, end: groupBy[groupBy.length - 1].end };
    }

    let having: Expr | undefined;
    let havingSpan: Span | undefined;
    if (this.isWord('HAVING')) {
      const hTok = this.next();
      having = this.parseExpr();
      havingSpan = { start: hTok.start, end: having.end };
    }

    if (this.isWord('WHERE')) {
      const t = this.peek();
      throw this.err('WHERE cannot appear after GROUP BY', t,
        'Filter rows with WHERE before grouping, or filter groups with HAVING after grouping.');
    }

    const endTok = this.toks[this.pos - 1];
    return {
      kind: 'select', distinct, items, from, where, groupBy, having,
      selectSpan, fromSpan, whereSpan, groupSpan, havingSpan,
      start: selTok.start, end: endTok.end,
    };
  }

  parseSelectItem(): SelectItem {
    // bare *
    if (this.isPunct('*')) {
      const t = this.next();
      const star: StarRef = { kind: 'star', start: t.start, end: t.end };
      return { expr: star, start: t.start, end: t.end };
    }
    const expr = this.parseExpr();
    let alias: string | undefined;
    let end = expr.end;
    if (this.matchWord('AS')) {
      const t = this.peek();
      if (t.type === 'word' || t.type === 'qword') {
        this.next();
        alias = t.text;
        end = t.end;
      } else {
        throw this.err(`Expected an alias name after AS, found ${this.describe(t)}`, t);
      }
    } else if (canBeBareAlias(this.peek())) {
      const t = this.next();
      alias = t.text;
      end = t.end;
    }
    return { expr, alias, start: expr.start, end };
  }

  parseTableRef(): TableRef {
    if (this.isPunct('(')) {
      const open = this.next();
      if (this.isWord('SELECT') || this.isWord('WITH') || this.isPunct('(')) {
        const q = this.parseQueryFull();
        const close = this.expectPunct(')', 'to close the subquery');
        let alias: string | undefined;
        if (this.matchWord('AS')) alias = this.expectName('subquery alias').name;
        else if (canBeBareAlias(this.peek())) alias = this.next().text;
        if (!alias) {
          throw this.err('A subquery in FROM needs an alias', close,
            'Add a name after the closing parenthesis, e.g. (SELECT ...) AS sub — the outer query refers to its columns through that name.');
        }
        return { kind: 'subqueryTable', query: q, alias, start: open.start, end: this.toks[this.pos - 1].end };
      }
      throw this.err('Expected a subquery after ( in FROM', this.peek());
    }
    const { name, tok } = this.expectName('table name');
    let alias: string | undefined;
    let end = tok.end;
    if (this.matchWord('AS')) {
      const a = this.expectName('table alias');
      alias = a.name;
      end = a.tok.end;
    } else if (canBeBareAlias(this.peek())) {
      const t = this.next();
      alias = t.text;
      end = t.end;
    }
    return { kind: 'table', name, alias, start: tok.start, end };
  }

  tryParseJoin(): Join | null {
    // old-style comma join => CROSS JOIN
    if (this.isPunct(',')) {
      const c = this.next();
      const table = this.parseTableRef();
      return { type: 'cross', table, start: c.start, end: table.end };
    }
    let type: JoinType | null = null;
    const startTok = this.peek();
    if (this.isWord('JOIN')) {
      this.next();
      type = 'inner';
    } else if (this.isWord('INNER')) {
      this.next();
      this.expectWord('JOIN');
      type = 'inner';
    } else if (this.isWord('LEFT') && !this.isPunct('(', 1)) {
      this.next();
      this.matchWord('OUTER');
      this.expectWord('JOIN');
      type = 'left';
    } else if (this.isWord('RIGHT') && !this.isPunct('(', 1)) {
      this.next();
      this.matchWord('OUTER');
      this.expectWord('JOIN');
      type = 'right';
    } else if (this.isWord('FULL')) {
      this.next();
      this.matchWord('OUTER');
      this.expectWord('JOIN');
      type = 'full';
    } else if (this.isWord('CROSS')) {
      this.next();
      this.expectWord('JOIN');
      type = 'cross';
    }
    if (!type) return null;

    const table = this.parseTableRef();
    let on: Expr | undefined;
    let using: string[] | undefined;
    let end = table.end;
    if (this.matchWord('ON')) {
      on = this.parseExpr();
      end = on.end;
    } else if (this.matchWord('USING')) {
      this.expectPunct('(');
      using = [];
      for (;;) {
        using.push(this.expectName('column name').name);
        if (this.isPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
      end = this.expectPunct(')').end;
    } else if (type !== 'cross') {
      throw this.err(`This ${type.toUpperCase()} JOIN is missing its ON condition`, this.peek(),
        'Tell SQL how the tables relate, e.g. ON a.id = b.account_id. Without ON, every row pairs with every row (a cross join).');
    }
    return { type, table, on, using, start: startTok.start, end };
  }

  parseOrderItems(): OrderItem[] {
    const items: OrderItem[] = [];
    for (;;) {
      const expr = this.parseExpr();
      let desc = false;
      let nulls: 'first' | 'last' | undefined;
      let end = expr.end;
      const d = this.matchWord('ASC', 'DESC');
      if (d) {
        desc = d.upper === 'DESC';
        end = d.end;
      }
      if (this.matchWord('NULLS')) {
        const w = this.matchWord('FIRST', 'LAST');
        if (!w) throw this.err('Expected FIRST or LAST after NULLS', this.peek());
        nulls = w.upper === 'FIRST' ? 'first' : 'last';
        end = w.end;
      }
      items.push({ expr, desc, nulls, start: expr.start, end });
      if (this.isPunct(',')) {
        this.next();
        continue;
      }
      break;
    }
    return items;
  }

  // ---------- expressions ----------

  parseExpr(): Expr {
    return this.parseOr();
  }

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isWord('OR')) {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'or', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isWord('AND')) {
      this.next();
      const right = this.parseNot();
      left = { kind: 'binary', op: 'and', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  parseNot(): Expr {
    if (this.isWord('NOT') && !this.isWord('EXISTS', 1)) {
      const t = this.next();
      const operand = this.parseNot();
      return { kind: 'unary', op: 'not', operand, start: t.start, end: operand.end };
    }
    return this.parseComparison();
  }

  parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.text)) {
        this.next();
        const right = this.parseAdditive();
        const op = (t.text === '!=' ? '<>' : t.text) as '=' | '<>' | '<' | '<=' | '>' | '>=';
        left = { kind: 'binary', op, left, right, start: left.start, end: right.end };
        continue;
      }
      if (this.isWord('IS')) {
        this.next();
        const negated = !!this.matchWord('NOT');
        if (this.matchWord('NULL')) {
          left = { kind: 'isnull', operand: left, negated, start: left.start, end: this.toks[this.pos - 1].end };
          continue;
        }
        const b = this.matchWord('TRUE', 'FALSE');
        if (b) {
          const cmp: Expr = {
            kind: 'binary', op: '=', left,
            right: { kind: 'bool', value: b.upper === 'TRUE', start: b.start, end: b.end },
            start: left.start, end: b.end,
          };
          left = negated ? { kind: 'unary', op: 'not', operand: cmp, start: left.start, end: b.end } : cmp;
          continue;
        }
        throw this.err('Expected NULL, TRUE, or FALSE after IS', this.peek());
      }
      let negated = false;
      let notTok: Token | null = null;
      if (this.isWord('NOT') && (this.isWord('IN', 1) || this.isWord('BETWEEN', 1) || this.isWord('LIKE', 1) || this.isWord('ILIKE', 1))) {
        notTok = this.next();
        negated = true;
      }
      if (this.isWord('IN')) {
        this.next();
        this.expectPunct('(', 'after IN');
        if (this.isWord('SELECT') || this.isWord('WITH')) {
          const q = this.parseQueryFull();
          const close = this.expectPunct(')');
          left = { kind: 'in', operand: left, negated, query: q, start: left.start, end: close.end };
        } else {
          const list: Expr[] = [];
          for (;;) {
            list.push(this.parseExpr());
            if (this.isPunct(',')) {
              this.next();
              continue;
            }
            break;
          }
          const close = this.expectPunct(')', 'to close the IN list');
          left = { kind: 'in', operand: left, negated, list, start: left.start, end: close.end };
        }
        continue;
      }
      if (this.isWord('BETWEEN')) {
        this.next();
        const low = this.parseAdditive();
        this.expectWord('AND', 'in BETWEEN low AND high');
        const high = this.parseAdditive();
        left = { kind: 'between', operand: left, negated, low, high, start: left.start, end: high.end };
        continue;
      }
      const likeTok = this.matchWord('LIKE', 'ILIKE');
      if (likeTok) {
        const pattern = this.parseAdditive();
        left = {
          kind: 'like', operand: left, negated,
          caseInsensitive: likeTok.upper === 'ILIKE', pattern,
          start: left.start, end: pattern.end,
        };
        continue;
      }
      if (notTok) throw this.err('Expected IN, BETWEEN, or LIKE after NOT', this.peek());
      return left;
    }
  }

  parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.text === '+' || t.text === '-' || t.text === '||')) {
        this.next();
        const right = this.parseMultiplicative();
        left = { kind: 'binary', op: t.text as '+' | '-' | '||', left, right, start: left.start, end: right.end };
      } else return left;
    }
  }

  parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.text === '*' || t.text === '/' || t.text === '%')) {
        this.next();
        const right = this.parseUnary();
        left = { kind: 'binary', op: t.text as '*' | '/' | '%', left, right, start: left.start, end: right.end };
      } else return left;
    }
  }

  parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'op' && (t.text === '-' || t.text === '+')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', op: t.text as '-' | '+', operand, start: t.start, end: operand.end };
    }
    return this.parsePostfix();
  }

  parsePostfix(): Expr {
    let e = this.parsePrimary();
    while (this.isPunct('::')) {
      this.next();
      const type = this.parseTypeName();
      e = { kind: 'cast', operand: e, type, start: e.start, end: this.toks[this.pos - 1].end };
    }
    return e;
  }

  parseTypeName(): string {
    const t = this.peek();
    if (t.type !== 'word') throw this.err('Expected a type name', t);
    this.next();
    let name = t.text.toLowerCase();
    if (name === 'double' && this.isWord('PRECISION')) {
      this.next();
      name = 'double precision';
    }
    if (name === 'character' && this.isWord('VARYING')) {
      this.next();
      name = 'varchar';
    }
    // swallow precision like numeric(10,2) / varchar(50)
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const p = this.next();
        if (p.type === 'eof') throw this.err('Unterminated type precision', p);
      }
      this.next();
    }
    return name;
  }

  parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === 'num') {
      this.next();
      return { kind: 'num', value: parseFloat(t.text), start: t.start, end: t.end };
    }
    if (t.type === 'str') {
      this.next();
      return { kind: 'str', value: t.text, start: t.start, end: t.end };
    }
    if (t.type === 'word') {
      switch (t.upper) {
        case 'NULL':
          this.next();
          return { kind: 'null', start: t.start, end: t.end };
        case 'TRUE':
        case 'FALSE':
          this.next();
          return { kind: 'bool', value: t.upper === 'TRUE', start: t.start, end: t.end };
        case 'CASE':
          return this.parseCase();
        case 'CAST': {
          this.next();
          this.expectPunct('(', 'after CAST');
          const operand = this.parseExpr();
          this.expectWord('AS', 'in CAST(expr AS type)');
          const type = this.parseTypeName();
          const close = this.expectPunct(')');
          return { kind: 'cast', operand, type, start: t.start, end: close.end };
        }
        case 'EXTRACT': {
          this.next();
          this.expectPunct('(', 'after EXTRACT');
          const f = this.peek();
          if (f.type !== 'word') throw this.err('Expected a field name (year, month, day, hour, ...) in EXTRACT', f);
          this.next();
          this.expectWord('FROM', 'in EXTRACT(field FROM value)');
          const operand = this.parseExpr();
          const close = this.expectPunct(')');
          return { kind: 'extract', field: f.text.toLowerCase(), operand, start: t.start, end: close.end };
        }
        case 'INTERVAL': {
          this.next();
          const s = this.peek();
          if (s.type !== 'str') throw this.err("INTERVAL expects a quoted value, e.g. INTERVAL '1 day'", s);
          this.next();
          return { kind: 'interval', text: s.text, start: t.start, end: s.end };
        }
        case 'DATE':
        case 'TIMESTAMP': {
          if (this.peek(1).type === 'str') {
            this.next();
            const s = this.next();
            return { kind: 'str', value: s.text, start: t.start, end: s.end };
          }
          break;
        }
        case 'NOT':
        case 'EXISTS': {
          const negated = t.upper === 'NOT';
          if (negated) {
            this.next();
            this.expectWord('EXISTS');
          } else this.next();
          this.expectPunct('(', 'after EXISTS');
          const q = this.parseQueryFull();
          const close = this.expectPunct(')');
          return { kind: 'exists', query: q, negated, start: t.start, end: close.end };
        }
      }

      // function call
      if (this.isPunct('(', 1) && (!KEYWORDS.has(t.upper) || FUNC_KEYWORDS.has(t.upper))) {
        return this.parseCall();
      }
      // no-paren pseudo-functions
      if (['CURRENT_DATE', 'CURRENT_TIMESTAMP', 'NOW'].includes(t.upper) && !this.isPunct('(', 1)) {
        this.next();
        return { kind: 'call', name: t.text.toLowerCase(), args: [], start: t.start, end: t.end };
      }
      // column reference (possibly qualified, possibly t.*)
      if (!KEYWORDS.has(t.upper)) {
        return this.parseColRef();
      }
      throw this.err(`Unexpected keyword '${t.text}' — expected a value or column here`, t);
    }
    if (t.type === 'qword') {
      return this.parseColRef();
    }
    if (this.isPunct('(')) {
      this.next();
      if (this.isWord('SELECT') || this.isWord('WITH')) {
        const q = this.parseQueryFull();
        const close = this.expectPunct(')', 'to close the subquery');
        return { kind: 'subquery', query: q, start: t.start, end: close.end };
      }
      const e = this.parseExpr();
      const close = this.expectPunct(')', 'to close the parenthesis');
      return { ...e, start: t.start, end: close.end };
    }
    if (this.isPunct('*')) {
      this.next();
      return { kind: 'star', start: t.start, end: t.end };
    }
    throw this.err(`Expected a value, column, or expression, found ${this.describe(t)}`, t);
  }

  parseColRef(): Expr {
    const first = this.next(); // word or qword
    if (this.isPunct('.')) {
      this.next();
      const second = this.peek();
      if (this.isPunct('*')) {
        this.next();
        const star: StarRef = { kind: 'star', table: first.text, start: first.start, end: second.end };
        return star;
      }
      if (second.type === 'word' || second.type === 'qword') {
        this.next();
        const col: ColRef = {
          kind: 'col', table: first.text, name: second.text,
          start: first.start, end: second.end,
        };
        return col;
      }
      throw this.err(`Expected a column name after '${first.text}.'`, second);
    }
    const col: ColRef = { kind: 'col', name: first.text, start: first.start, end: first.end };
    if (first.type === 'qword') (col as ColRef & { quoted?: boolean }).quoted = true;
    return col;
  }

  parseCase(): Expr {
    const caseTok = this.expectWord('CASE');
    let operand: Expr | undefined;
    if (!this.isWord('WHEN')) operand = this.parseExpr();
    const branches: { when: Expr; then: Expr }[] = [];
    while (this.matchWord('WHEN')) {
      const when = this.parseExpr();
      this.expectWord('THEN', 'after the WHEN condition');
      const then = this.parseExpr();
      branches.push({ when, then });
    }
    if (branches.length === 0) {
      throw this.err('CASE needs at least one WHEN ... THEN branch', this.peek());
    }
    let elseExpr: Expr | undefined;
    if (this.matchWord('ELSE')) elseExpr = this.parseExpr();
    const end = this.expectWord('END', 'to finish the CASE expression');
    return { kind: 'case', operand, branches, elseExpr, start: caseTok.start, end: end.end };
  }

  parseCall(): Expr {
    const nameTok = this.next();
    const name = nameTok.text.toLowerCase();
    this.expectPunct('(');
    let distinct = false;
    const args: Expr[] = [];
    if (!this.isPunct(')')) {
      if (this.matchWord('DISTINCT')) distinct = true;
      else this.matchWord('ALL');
      for (;;) {
        if (this.isPunct('*')) {
          const s = this.next();
          args.push({ kind: 'star', start: s.start, end: s.end });
        } else {
          args.push(this.parseExpr());
        }
        if (this.isPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    const close = this.expectPunct(')', `to close ${nameTok.text}(...)`);
    let over: WindowSpec | undefined;
    if (this.isWord('OVER')) {
      this.next();
      over = this.parseWindowSpec();
    }
    return { kind: 'call', name, args, distinct, over, start: nameTok.start, end: over ? over.end : close.end };
  }

  parseWindowSpec(): WindowSpec {
    const open = this.expectPunct('(', 'after OVER');
    const partitionBy: Expr[] = [];
    let orderBy: OrderItem[] = [];
    let frame: WindowSpec['frame'];
    if (this.matchWord('PARTITION')) {
      this.expectWord('BY', 'after PARTITION');
      for (;;) {
        partitionBy.push(this.parseExpr());
        if (this.isPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    if (this.matchWord('ORDER')) {
      this.expectWord('BY', 'after ORDER');
      orderBy = this.parseOrderItems();
    }
    if (this.matchWord('ROWS')) {
      if (this.matchWord('BETWEEN')) {
        const start = this.parseFrameBound();
        this.expectWord('AND', 'in ROWS BETWEEN ... AND ...');
        const end = this.parseFrameBound();
        frame = { start, end };
      } else {
        frame = { start: this.parseFrameBound(), end: { type: 'currentRow' } };
      }
    }
    const close = this.expectPunct(')', 'to close the OVER clause');
    return { partitionBy, orderBy, frame, start: open.start, end: close.end };
  }

  parseFrameBound(): FrameBound {
    if (this.matchWord('UNBOUNDED')) {
      const w = this.matchWord('PRECEDING', 'FOLLOWING');
      if (!w) throw this.err('Expected PRECEDING or FOLLOWING after UNBOUNDED', this.peek());
      return { type: w.upper === 'PRECEDING' ? 'unboundedPreceding' : 'unboundedFollowing' };
    }
    if (this.matchWord('CURRENT')) {
      this.expectWord('ROW', 'after CURRENT');
      return { type: 'currentRow' };
    }
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      const w = this.matchWord('PRECEDING', 'FOLLOWING');
      if (!w) throw this.err('Expected PRECEDING or FOLLOWING after the frame offset', this.peek());
      return { type: w.upper === 'PRECEDING' ? 'preceding' : 'following', offset: parseInt(t.text, 10) };
    }
    throw this.err('Expected a window frame bound (UNBOUNDED PRECEDING, n PRECEDING, CURRENT ROW, ...)', t);
  }
}
