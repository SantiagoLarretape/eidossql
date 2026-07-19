// Scalar and aggregate function implementations (Postgres-flavored subset).

import { SqlError } from './tokens';
import type { Value, Interval } from './values';
import { isInterval, isDateLike, toDate, fromDate, intervalParts, orderCompare } from './values';

type Fn = (args: Value[], span: { start: number; end: number }) => Value;

function num(v: Value, name: string, span: { start: number; end: number }): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  throw new SqlError(`${name}() expects a number, got '${String(v)}'`, span.start, span.end);
}

function str(v: Value): string | null {
  if (v === null) return null;
  if (isInterval(v)) return String(v.ms);
  return String(v);
}

export const SCALAR_FUNCS: Record<string, Fn> = {
  upper: ([a]) => (a === null ? null : String(a).toUpperCase()),
  lower: ([a]) => (a === null ? null : String(a).toLowerCase()),
  initcap: ([a]) =>
    a === null ? null : String(a).toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_, b, c) => b + c.toUpperCase()),
  length: ([a]) => (a === null ? null : String(a).length),
  char_length: ([a]) => (a === null ? null : String(a).length),
  trim: ([a]) => (a === null ? null : String(a).trim()),
  ltrim: ([a]) => (a === null ? null : String(a).replace(/^\s+/, '')),
  rtrim: ([a]) => (a === null ? null : String(a).replace(/\s+$/, '')),
  concat: (args) => args.map((a) => (a === null ? '' : String(a))).join(''),
  left: ([a, n], sp) => {
    const s = str(a);
    const k = num(n, 'left', sp);
    if (s === null || k === null) return null;
    return k >= 0 ? s.slice(0, k) : s.slice(0, Math.max(0, s.length + k));
  },
  right: ([a, n], sp) => {
    const s = str(a);
    const k = num(n, 'right', sp);
    if (s === null || k === null) return null;
    return k >= 0 ? (k === 0 ? '' : s.slice(-k)) : s.slice(Math.min(-k, s.length));
  },
  substr: substrImpl,
  substring: substrImpl,
  replace: ([a, b, c]) => {
    const s = str(a), f = str(b), r = str(c);
    if (s === null || f === null || r === null) return null;
    return f === '' ? s : s.split(f).join(r);
  },
  strpos: ([a, b]) => {
    const s = str(a), f = str(b);
    if (s === null || f === null) return null;
    return s.indexOf(f) + 1;
  },
  coalesce: (args) => args.find((a) => a !== null) ?? null,
  nullif: ([a, b]) => (orderCompare(a, b) === 0 && a !== null && b !== null ? null : a),
  greatest: (args) => {
    const vs = args.filter((a) => a !== null);
    if (!vs.length) return null;
    return vs.reduce((m, v) => (orderCompare(v, m) > 0 ? v : m));
  },
  least: (args) => {
    const vs = args.filter((a) => a !== null);
    if (!vs.length) return null;
    return vs.reduce((m, v) => (orderCompare(v, m) < 0 ? v : m));
  },
  round: ([a, n], sp) => {
    const x = num(a, 'round', sp);
    if (x === null) return null;
    const d = n === undefined ? 0 : (num(n, 'round', sp) ?? 0);
    const f = Math.pow(10, d);
    return Math.round((x + Number.EPSILON) * f) / f;
  },
  ceil: ([a], sp) => nullableMap(num(a, 'ceil', sp), Math.ceil),
  ceiling: ([a], sp) => nullableMap(num(a, 'ceiling', sp), Math.ceil),
  floor: ([a], sp) => nullableMap(num(a, 'floor', sp), Math.floor),
  abs: ([a], sp) => nullableMap(num(a, 'abs', sp), Math.abs),
  sqrt: ([a], sp) => nullableMap(num(a, 'sqrt', sp), Math.sqrt),
  power: ([a, b], sp) => {
    const x = num(a, 'power', sp), y = num(b, 'power', sp);
    return x === null || y === null ? null : Math.pow(x, y);
  },
  pow: ([a, b], sp) => SCALAR_FUNCS.power([a, b], sp),
  mod: ([a, b], sp) => {
    const x = num(a, 'mod', sp), y = num(b, 'mod', sp);
    return x === null || y === null ? null : x % y;
  },
  date_trunc: ([f, v], sp) => dateTrunc(str(f), v, sp),
  date_part: ([f, v], sp) => extractField(str(f) ?? '', v, sp),
  now: () => nowString(),
  current_timestamp: () => nowString(),
  current_date: () => nowString().slice(0, 10),
  age: ([a, b], sp) => {
    if (a === null || b === null) return null;
    if (!isDateLike(a as string) || !isDateLike(b as string))
      throw new SqlError('age() expects dates or timestamps', sp.start, sp.end);
    return { kind: 'interval', ms: toDate(a as string).getTime() - toDate(b as string).getTime() } as Interval;
  },
  to_char: ([v, fmt], sp) => toChar(v, str(fmt), sp),
};

function nullableMap(x: number | null, f: (n: number) => number): Value {
  return x === null ? null : f(x);
}

function substrImpl([a, from, count]: Value[], sp: { start: number; end: number }): Value {
  const s = str(a);
  if (s === null) return null;
  const f = num(from, 'substring', sp);
  if (f === null) return null;
  const startIdx = Math.max(0, f - 1);
  if (count === undefined) return s.slice(startIdx);
  const c = num(count, 'substring', sp);
  if (c === null) return null;
  if (c < 0) throw new SqlError('negative substring length not allowed', sp.start, sp.end);
  return s.slice(startIdx, Math.max(startIdx, f - 1 + c));
}

function nowString(): string {
  return fromDate(new Date(), true);
}

export function extractField(field: string, v: Value, sp: { start: number; end: number }): Value {
  if (v === null) return null;
  field = field.toLowerCase();
  if (isInterval(v)) {
    const { sign, days, hours, minutes, seconds } = intervalParts(v);
    switch (field) {
      case 'day': return sign * days;
      case 'hour': return sign * hours;
      case 'minute': return sign * minutes;
      case 'second': return sign * seconds;
      case 'epoch': return v.ms / 1000;
      default:
        throw new SqlError(`Cannot extract '${field}' from an interval`, sp.start, sp.end,
          'Intervals support day, hour, minute, second, and epoch.');
    }
  }
  if (typeof v === 'string' && isDateLike(v)) {
    const d = toDate(v);
    switch (field) {
      case 'year': return d.getUTCFullYear();
      case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1;
      case 'month': return d.getUTCMonth() + 1;
      case 'week': return isoWeek(d);
      case 'day': return d.getUTCDate();
      case 'dow': return d.getUTCDay();
      case 'isodow': return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      case 'doy': {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        return Math.floor((d.getTime() - start) / 86400000) + 1;
      }
      case 'hour': return d.getUTCHours();
      case 'minute': return d.getUTCMinutes();
      case 'second': return d.getUTCSeconds();
      case 'epoch': return d.getTime() / 1000;
      default:
        throw new SqlError(`Unknown field '${field}' in EXTRACT`, sp.start, sp.end,
          'Try year, quarter, month, week, day, dow, hour, minute, or second.');
    }
  }
  throw new SqlError(`EXTRACT expects a date, timestamp, or interval value`, sp.start, sp.end,
    'The value being extracted from is not date-like. Check the column type.');
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function dateTrunc(field: string | null, v: Value, sp: { start: number; end: number }): Value {
  if (field === null || v === null) return null;
  if (typeof v !== 'string' || !isDateLike(v))
    throw new SqlError('date_trunc expects a date or timestamp', sp.start, sp.end);
  const d = toDate(v);
  const f = field.toLowerCase();
  const y = d.getUTCFullYear();
  switch (f) {
    case 'year': return fromDate(new Date(Date.UTC(y, 0, 1)), true);
    case 'quarter': return fromDate(new Date(Date.UTC(y, Math.floor(d.getUTCMonth() / 3) * 3, 1)), true);
    case 'month': return fromDate(new Date(Date.UTC(y, d.getUTCMonth(), 1)), true);
    case 'week': {
      const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      const t = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - (dayNum - 1)));
      return fromDate(t, true);
    }
    case 'day': return fromDate(new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate())), true);
    case 'hour': return fromDate(new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())), true);
    case 'minute': return fromDate(new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes())), true);
    default:
      throw new SqlError(`Unknown field '${field}' in date_trunc`, sp.start, sp.end,
        "Try 'year', 'quarter', 'month', 'week', 'day', 'hour', or 'minute'.");
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toChar(v: Value, fmt: string | null, sp: { start: number; end: number }): Value {
  if (v === null || fmt === null) return null;
  if (typeof v === 'number') {
    // minimal numeric to_char: just render the number
    return String(v);
  }
  if (typeof v !== 'string' || !isDateLike(v))
    throw new SqlError('to_char expects a date/timestamp and a format', sp.start, sp.end);
  const d = toDate(v);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const reps: [RegExp, string][] = [
    [/YYYY/g, String(d.getUTCFullYear())],
    [/YY/g, String(d.getUTCFullYear()).slice(-2)],
    [/Month/g, MONTHS[d.getUTCMonth()]],
    [/MON/g, MONTHS[d.getUTCMonth()].slice(0, 3).toUpperCase()],
    [/Mon/g, MONTHS[d.getUTCMonth()].slice(0, 3)],
    [/MM/g, p(d.getUTCMonth() + 1)],
    [/Day/g, DAYS[d.getUTCDay()]],
    [/DY/g, DAYS[d.getUTCDay()].slice(0, 3).toUpperCase()],
    [/Dy/g, DAYS[d.getUTCDay()].slice(0, 3)],
    [/DD/g, p(d.getUTCDate())],
    [/HH24/g, p(d.getUTCHours())],
    [/HH12/g, p(d.getUTCHours() % 12 || 12)],
    [/HH/g, p(d.getUTCHours() % 12 || 12)],
    [/MI/g, p(d.getUTCMinutes())],
    [/SS/g, p(d.getUTCSeconds())],
  ];
  let out = fmt;
  for (const [re, rep] of reps) out = out.replace(re, rep);
  return out;
}

export function parseIntervalLiteral(text: string, sp: { start: number; end: number }): Interval {
  // supports e.g. '3 days', '1 day 02:30:00', '90 minutes', '02:30:00', '1 week', '1 year'
  let ms = 0;
  let matched = false;
  const unitRe = /(-?\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute|min|second|sec)s?/gi;
  const UNIT_MS: Record<string, number> = {
    year: 365 * 86400000, month: 30 * 86400000, week: 7 * 86400000,
    day: 86400000, hour: 3600000, minute: 60000, min: 60000, second: 1000, sec: 1000,
  };
  let m: RegExpExecArray | null;
  while ((m = unitRe.exec(text))) {
    ms += parseFloat(m[1]) * UNIT_MS[m[2].toLowerCase()];
    matched = true;
  }
  const timeRe = /(\d+):(\d{2})(?::(\d{2}))?/.exec(text);
  if (timeRe) {
    ms += parseInt(timeRe[1], 10) * 3600000 + parseInt(timeRe[2], 10) * 60000 + (timeRe[3] ? parseInt(timeRe[3], 10) * 1000 : 0);
    matched = true;
  }
  if (!matched) {
    throw new SqlError(`Cannot understand interval '${text}'`, sp.start, sp.end,
      "Try something like INTERVAL '3 days' or INTERVAL '02:30:00'.");
  }
  return { kind: 'interval', ms };
}

// ---------- aggregates ----------

export const AGG_FUNC_NAMES = new Set(['count', 'sum', 'avg', 'min', 'max']);
export const WINDOW_ONLY_FUNCS = new Set([
  'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value',
]);

/** Compute an aggregate over already-evaluated argument values (one per row). */
export function computeAggregate(
  name: string,
  values: Value[],
  isStar: boolean,
  distinct: boolean,
  sp: { start: number; end: number },
): Value {
  if (name === 'count' && isStar) return values.length;
  let vs = values.filter((v) => v !== null);
  if (distinct) {
    const seen = new Set<string>();
    vs = vs.filter((v) => {
      const k = isInterval(v) ? `iv${v.ms}` : `${typeof v}:${String(v)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  switch (name) {
    case 'count':
      return vs.length;
    case 'sum': {
      if (!vs.length) return null;
      let total = 0;
      for (const v of vs) {
        if (typeof v !== 'number') {
          const n = Number(v);
          if (isNaN(n)) throw new SqlError(`sum() expects numbers, got '${String(v)}'`, sp.start, sp.end);
          total += n;
        } else total += v;
      }
      return total;
    }
    case 'avg': {
      if (!vs.length) return null;
      const total = computeAggregate('sum', vs, false, false, sp) as number;
      return total / vs.length;
    }
    case 'min': {
      if (!vs.length) return null;
      return vs.reduce((m, v) => (orderCompare(v, m) < 0 ? v : m));
    }
    case 'max': {
      if (!vs.length) return null;
      return vs.reduce((m, v) => (orderCompare(v, m) > 0 ? v : m));
    }
    default:
      throw new SqlError(`Unknown aggregate function ${name}()`, sp.start, sp.end);
  }
}
