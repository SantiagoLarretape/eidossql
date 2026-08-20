// AST node definitions. Every node carries a source span so the UI can
// highlight the clause of the query that each visualization step corresponds to.

export interface Span {
  start: number;
  end: number;
}

// ---------- expressions ----------

export type Expr =
  | NumLit
  | StrLit
  | BoolLit
  | NullLit
  | IntervalLit
  | ColRef
  | StarRef
  | Call
  | Unary
  | Binary
  | CaseExpr
  | CastExpr
  | ExtractExpr
  | InExpr
  | BetweenExpr
  | LikeExpr
  | IsNullExpr
  | ExistsExpr
  | Subquery;

export interface NumLit extends Span {
  kind: 'num';
  value: number;
}
export interface StrLit extends Span {
  kind: 'str';
  value: string;
}
export interface BoolLit extends Span {
  kind: 'bool';
  value: boolean;
}
export interface NullLit extends Span {
  kind: 'null';
}
export interface IntervalLit extends Span {
  kind: 'interval';
  text: string;
}
export interface ColRef extends Span {
  kind: 'col';
  table?: string;
  name: string;
}
/** `*` or `t.*` — only valid in SELECT list / COUNT(*) */
export interface StarRef extends Span {
  kind: 'star';
  table?: string;
}
export interface OrderItem extends Span {
  expr: Expr;
  desc: boolean;
  nulls?: 'first' | 'last';
}
export interface FrameBound {
  type: 'unboundedPreceding' | 'preceding' | 'currentRow' | 'following' | 'unboundedFollowing';
  offset?: number;
}
export interface WindowSpec extends Span {
  partitionBy: Expr[];
  orderBy: OrderItem[];
  frame?: { start: FrameBound; end: FrameBound };
}
export interface Call extends Span {
  kind: 'call';
  name: string; // lowercased
  args: Expr[];
  distinct?: boolean;
  over?: WindowSpec;
}
export interface Unary extends Span {
  kind: 'unary';
  op: '-' | '+' | 'not';
  operand: Expr;
}
export interface Binary extends Span {
  kind: 'binary';
  op: '=' | '<>' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | '||' | 'and' | 'or';
  left: Expr;
  right: Expr;
}
export interface CaseExpr extends Span {
  kind: 'case';
  operand?: Expr; // CASE x WHEN v THEN ...
  branches: { when: Expr; then: Expr }[];
  elseExpr?: Expr;
}
export interface CastExpr extends Span {
  kind: 'cast';
  operand: Expr;
  type: string; // lowercased target type
}
export interface ExtractExpr extends Span {
  kind: 'extract';
  field: string; // lowercased: year, month, day, hour, ...
  operand: Expr;
}
export interface InExpr extends Span {
  kind: 'in';
  operand: Expr;
  negated: boolean;
  list?: Expr[];
  query?: Query;
}
export interface BetweenExpr extends Span {
  kind: 'between';
  operand: Expr;
  negated: boolean;
  low: Expr;
  high: Expr;
}
export interface LikeExpr extends Span {
  kind: 'like';
  operand: Expr;
  negated: boolean;
  caseInsensitive: boolean;
  pattern: Expr;
}
export interface IsNullExpr extends Span {
  kind: 'isnull';
  operand: Expr;
  negated: boolean;
}
export interface ExistsExpr extends Span {
  kind: 'exists';
  query: Query;
  negated: boolean;
}
export interface Subquery extends Span {
  kind: 'subquery';
  query: Query;
}

// ---------- queries ----------

export interface SelectItem extends Span {
  expr: Expr; // StarRef for `*` / `t.*`
  alias?: string;
}

export type TableRef = BaseTableRef | SubqueryTableRef;

export interface BaseTableRef extends Span {
  kind: 'table';
  name: string;
  alias?: string;
}
export interface SubqueryTableRef extends Span {
  kind: 'subqueryTable';
  query: Query;
  alias: string;
}

export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross';

export interface Join extends Span {
  type: JoinType;
  table: TableRef;
  on?: Expr;
  using?: string[];
}

export interface SelectCore extends Span {
  kind: 'select';
  distinct: boolean;
  items: SelectItem[];
  from?: { base: TableRef; joins: Join[] };
  where?: Expr;
  groupBy?: Expr[];
  having?: Expr;
  // clause spans for step highlighting
  selectSpan: Span;
  fromSpan?: Span;
  whereSpan?: Span;
  groupSpan?: Span;
  havingSpan?: Span;
}

export interface SetOp extends Span {
  kind: 'setop';
  op: 'union' | 'unionAll' | 'intersect' | 'except';
  left: QueryBody;
  right: QueryBody;
  opSpan: Span;
}

/** VALUES (…), (…) — an inline table of literal rows. */
export interface ValuesClause extends Span {
  kind: 'values';
  rows: Expr[][];
}

export type QueryBody = SelectCore | SetOp | Query | ValuesClause; // Query = parenthesized subselect

export interface Cte extends Span {
  name: string;
  /** optional column list: WITH months(mnum, mname) AS (…) */
  columns?: string[];
  query: Query;
}

export interface Query extends Span {
  kind: 'query';
  ctes: Cte[];
  body: QueryBody;
  orderBy?: OrderItem[];
  limit?: number;
  offset?: number;
  withSpan?: Span;
  orderSpan?: Span;
  limitSpan?: Span;
}
