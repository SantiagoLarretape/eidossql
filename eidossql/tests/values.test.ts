// Value semantics: three-valued logic, interval decomposition, and the
// NULL-aware grouping key — the invisible rules everything else sits on.

import { describe, it, expect } from 'vitest';
import {
  compareValues, orderCompare, truthy, groupKey, formatInterval,
} from '../src/engine/values';
import type { Interval } from '../src/engine/values';

const iv = (ms: number): Interval => ({ kind: 'interval', ms });

describe('three-valued logic', () => {
  it('comparisons with NULL are unknown, not false', () => {
    expect(compareValues(null, 1)).toBeNull();
    expect(compareValues('a', null)).toBeNull();
    expect(compareValues(null, null)).toBeNull();
  });

  it('WHERE truthiness rejects both false and NULL', () => {
    expect(truthy(true)).toBe(true);
    expect(truthy(false)).toBe(false);
    expect(truthy(null)).toBe(false);
  });

  it('numeric-looking strings compare numerically (teaching leniency)', () => {
    expect(compareValues(5, '10')).toBeLessThan(0);
    expect(compareValues('10', 5)).toBeGreaterThan(0);
  });

  it('ISO timestamps order correctly as strings', () => {
    expect(orderCompare('2016-12-24 05:53:13', '2016-05-01 15:40:04')).toBeGreaterThan(0);
  });
});

describe('grouping key', () => {
  it('treats NULLs as equal (SQL GROUP BY / DISTINCT rule)', () => {
    expect(groupKey([null])).toBe(groupKey([null]));
  });

  it('distinguishes NULL from empty string and from zero', () => {
    expect(groupKey([null])).not.toBe(groupKey(['']));
    expect(groupKey([null])).not.toBe(groupKey([0]));
  });

  it('is order-sensitive across columns', () => {
    expect(groupKey([1, 'a'])).not.toBe(groupKey(['a', 1]));
  });
});

describe('intervals (Postgres decomposition)', () => {
  it('splits into days + time of day', () => {
    // 1 day, 2h 30m
    expect(formatInterval(iv(26.5 * 3600000))).toBe('1 day 02:30:00');
  });

  it('formats sub-day intervals as hh:mm:ss', () => {
    expect(formatInterval(iv(90 * 60000))).toBe('01:30:00');
  });

  it('orders intervals by duration', () => {
    expect(compareValues(iv(1000), iv(2000))).toBeLessThan(0);
  });
});
