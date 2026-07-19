// Quick engine smoke test: runs representative queries (including the
// capstone examples) and prints step summaries + results.
import { runQuery } from '../src/engine';
import { parch } from '../src/data/datasets';
import { formatValue } from '../src/engine/values';
import type { Dataset } from '../src/data/datasets';
import { EXAMPLES } from '../src/ui/examples';

const CASES: { name: string; ds: Dataset; sql: string }[] = [
  {
    name: 'basic select',
    ds: parch,
    sql: `select id, name from accounts where id > 2000 order by name limit 3;`,
  },
  {
    name: 'join + group + having',
    ds: parch,
    sql: `select a.name, sum(o.total_amt_usd) as total_spent
from accounts a join orders o on o.account_id = a.id
group by a.name
having sum(o.total_amt_usd) > 5000
order by total_spent desc;`,
  },
  {
    name: 'left join nulls',
    ds: parch,
    sql: `select a.name, o.id from accounts a left join orders o on o.account_id = a.id where o.id is null;`,
  },
  {
    name: 'window running total',
    ds: parch,
    sql: `select account_id, occurred_at, total_amt_usd,
sum(total_amt_usd) over (partition by account_id order by occurred_at) as running_total
from orders where account_id in (1001, 1021);`,
  },
  {
    name: 'distinct + case',
    ds: parch,
    sql: `select distinct channel, case when channel = 'direct' then 'Direct' else 'Other' end as kind from web_events;`,
  },
  // every curated example must at least run
  ...EXAMPLES.map((e) => ({ name: `example: ${e.label}`, ds: parch, sql: e.sql })),
];

for (const c of CASES) {
  try {
    const { steps, result } = runQuery(c.sql, c.ds);
    console.log(`\n=== ${c.name} — OK, ${steps.length} steps ===`);
    console.log(
      steps.map((s) => `${' '.repeat(s.path.length * 2)}[${s.chip}] ${s.title} (${s.table.rows.length} rows)`).join('\n'),
    );
    console.log('columns:', result.columns.map((cc) => cc.label).join(' | '));
    for (const r of result.rows.slice(0, 4)) {
      console.log('  ', r.cells.map((v) => formatValue(v)).join(' | '));
    }
    if (result.rows.length > 4) console.log(`   … ${result.rows.length - 4} more`);
  } catch (err) {
    const e = err as Error & { hint?: string; start?: number };
    console.log(`\n=== ${c.name} — ERROR: ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''} @${e.start}`);
    process.exitCode = 1;
  }
}
