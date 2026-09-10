// Engine-vs-Postgres differential test.
//
// Loads the app's embedded datasets into a scratch Postgres database
// (eidossql_verify), runs a battery of queries through BOTH the JS engine
// and Postgres, and diffs the results. Queries without a top-level ORDER BY
// are compared as multisets.
//
//   npx tsx scripts/verify.ts

import { execFileSync } from 'node:child_process';
import { runQuery } from '../src/engine';
import { datasets, parch } from '../src/data/datasets';
import { northwind } from '../src/data/northwind';
import type { Dataset } from '../src/data/datasets';
import { isInterval, formatInterval } from '../src/engine/values';
import type { Value } from '../src/engine/values';

const DB = 'eidossql_verify';
const NULLTOK = '<<NULL>>';
const SEP = '\x1f';

function psql(args: string[], input?: string): string {
  return execFileSync('psql', ['-h', 'localhost', '-X', '-q', ...args], {
    input,
    encoding: 'utf8',
  });
}

function setupDb() {
  try {
    execFileSync('dropdb', ['-h', 'localhost', '--if-exists', DB], { encoding: 'utf8' });
  } catch { /* ignore */ }
  execFileSync('createdb', ['-h', 'localhost', DB], { encoding: 'utf8' });
  const stmts: string[] = [];
  for (const ds of datasets) {
    // one schema per dataset — Parch & Posey and Northwind both have `orders`/`region`
    stmts.push(`create schema "${ds.id}";`);
    for (const t of ds.tables) {
      const cols = t.columns.map((c) => `"${c.name}" ${pgType(c.type)}`).join(', ');
      stmts.push(`create table "${ds.id}"."${t.name}" (${cols});`);
      for (const row of t.rows) {
        const vals = row.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)).join(', ');
        stmts.push(`insert into "${ds.id}"."${t.name}" values (${vals});`);
      }
    }
  }
  psql(['-d', DB, '-v', 'ON_ERROR_STOP=1'], stmts.join('\n'));
}

function pgType(t: string): string {
  switch (t) {
    case 'integer': return 'integer';
    case 'numeric': return 'numeric(12,2)';
    case 'timestamp': return 'timestamp';
    case 'date': return 'date';
    default: return 'text';
  }
}

function pgRun(sql: string): string[][] {
  const out = psql(['-d', DB, '-A', '-t', '-F', SEP, '-P', `null=${NULLTOK}`, '-v', 'ON_ERROR_STOP=1'], sql);
  const lines = out.split('\n').filter((l) => l.length > 0);
  return lines.map((l) => l.split(SEP));
}

function engineCell(v: Value): string {
  if (v === null) return NULLTOK;
  if (isInterval(v)) return formatInterval(v);
  if (typeof v === 'boolean') return v ? 't' : 'f';
  return String(v);
}

function cellsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && a.trim() !== '' && b.trim() !== '') {
    return Math.abs(na - nb) <= 1e-6 * Math.max(1, Math.abs(na), Math.abs(nb));
  }
  return false;
}

function canon(rows: string[][]): string[] {
  return rows
    .map((r) => r.map((c) => {
      const n = Number(c);
      return !isNaN(n) && c.trim() !== '' && c !== NULLTOK ? String(Math.round(n * 1e6) / 1e6) : c;
    }).join(SEP))
    .sort();
}

interface Case {
  name: string;
  ds: Dataset;
  sql: string;
  ordered?: boolean; // top-level ORDER BY fully determines order
}

const CASES: Case[] = [
  { name: 'select columns', ds: parch, sql: 'select id, name from accounts;' },
  { name: 'select star', ds: parch, sql: 'select * from region;' },
  { name: 'where and/or', ds: parch, sql: "select id, name from accounts where sales_rep_id = 321500 or name = 'Visa';" },
  { name: 'where between', ds: parch, sql: 'select id, total from orders where total between 300 and 1000;' },
  { name: 'where like', ds: parch, sql: "select name from accounts where name like '%a%';" },
  { name: 'where ilike', ds: parch, sql: "select name from accounts where name ilike 'w%';" },
  { name: 'where in list', ds: parch, sql: 'select id, account_id from orders where account_id in (1001, 1021);' },
  { name: 'is null after left join', ds: parch, sql: 'select a.name from accounts a left join orders o on o.account_id = a.id where o.id is null;' },
  { name: 'order by limit offset', ds: parch, sql: 'select id, total_amt_usd from orders order by total_amt_usd desc, id limit 5 offset 2;', ordered: true },
  { name: 'order by ordinal + alias', ds: parch, sql: 'select name as account_name, sales_rep_id from accounts order by 2, account_name desc;', ordered: true },
  { name: 'distinct', ds: parch, sql: 'select distinct channel from web_events;' },
  { name: 'count distinct', ds: parch, sql: 'select count(distinct channel) as channels from web_events;' },
  { name: 'case searched', ds: parch, sql: "select id, case when total > 1000 then 'L' when total > 300 then 'M' else 'S' end as size from orders;" },
  { name: 'case operand', ds: parch, sql: "select channel, case channel when 'direct' then 1 when 'facebook' then 2 else 0 end as code from web_events;" },
  { name: 'arithmetic + int division', ds: parch, sql: 'select id, total / 2 as half, total_amt_usd / 2 as half_usd, 7 / 2 as intdiv from orders where id = 1;' },
  { name: 'string funcs', ds: parch, sql: "select upper(name) as u, lower(website) as l, length(name) as len, left(name, 3) as l3, right(name, 2) as r2, concat(name, '!') as bang, replace(name, 'a', '@') as rep from accounts;" },
  { name: 'coalesce nullif round', ds: parch, sql: 'select id, coalesce(gloss_qty, 0) as g, nullif(total, 169) as nn, round(total_amt_usd / 3.0, 2) as third from orders;' },
  { name: 'inner join', ds: parch, sql: 'select a.name, o.id, o.total from accounts a join orders o on o.account_id = a.id;' },
  { name: 'left join', ds: parch, sql: 'select a.name, o.id from accounts a left join orders o on o.account_id = a.id;' },
  { name: 'right join', ds: parch, sql: 'select s.name, a.name as account from accounts a right join sales_reps s on s.id = a.sales_rep_id;' },
  { name: 'full join', ds: parch, sql: 'select r.name, s.name as rep from sales_reps s full join region r on r.id = s.region_id;' },
  { name: 'cross join', ds: parch, sql: 'select r.name, s.name as rep from region r cross join sales_reps s where r.id = 1;' },
  { name: 'three-way join', ds: parch, sql: 'select a.name as account, s.name as rep, r.name as region from accounts a join sales_reps s on s.id = a.sales_rep_id join region r on r.id = s.region_id;' },
  { name: 'join using', ds: parch, sql: 'select o.id, w.channel from orders o join web_events w using (account_id);' },
  { name: 'join with residual condition', ds: parch, sql: 'select a.name, o.id from accounts a join orders o on o.account_id = a.id and o.total > 300;' },
  { name: 'non-equi join', ds: parch, sql: 'select r.id as region_id, s.id as rep_id from region r join sales_reps s on s.region_id < r.id;' },
  { name: 'group by + aggregates', ds: parch, sql: 'select account_id, count(*) as n, sum(total_amt_usd) as total, avg(total) as avg_qty, min(occurred_at) as first_order, max(total) as biggest from orders group by account_id;' },
  { name: 'group by expression', ds: parch, sql: 'select extract(year from occurred_at) as yr, count(*) as n from orders group by extract(year from occurred_at);' },
  { name: 'group by ordinal', ds: parch, sql: 'select channel, count(*) as n from web_events group by 1;' },
  { name: 'having', ds: parch, sql: 'select account_id, sum(total_amt_usd) as spent from orders group by account_id having sum(total_amt_usd) > 5000;' },
  { name: 'agg without group by', ds: parch, sql: 'select count(*) as n, sum(total) as total, avg(total_amt_usd) as avg_usd from orders;' },
  { name: 'having without group by', ds: parch, sql: 'select sum(total) as t from orders having count(*) > 5;' },
  { name: 'in subquery', ds: parch, sql: "select name from accounts where id in (select account_id from web_events where channel = 'facebook');" },
  { name: 'scalar subquery', ds: parch, sql: 'select id, total_amt_usd from orders where total_amt_usd > (select avg(total_amt_usd) from orders);' },
  { name: 'correlated exists', ds: parch, sql: 'select a.name from accounts a where exists (select 1 from orders o where o.account_id = a.id and o.total > 1000);' },
  { name: 'correlated scalar', ds: parch, sql: 'select a.name, (select count(*) from orders o where o.account_id = a.id) as n_orders from accounts a;' },
  { name: 'subquery in from', ds: parch, sql: 'select sub.account_id, sub.spent from (select account_id, sum(total_amt_usd) as spent from orders group by account_id) as sub where sub.spent > 8000;' },
  { name: 'cte', ds: parch, sql: 'with totals as (select account_id, sum(total_amt_usd) as spent from orders group by account_id) select a.name, t.spent from accounts a join totals t on t.account_id = a.id order by t.spent desc limit 5;', ordered: true },
  { name: 'two ctes', ds: parch, sql: 'with o as (select account_id, count(*) as n from orders group by account_id), w as (select account_id, count(*) as n from web_events group by account_id) select a.name, o.n as orders_n, w.n as events_n from accounts a join o on o.account_id = a.id join w on w.account_id = a.id;' },
  { name: 'union', ds: parch, sql: 'select account_id from orders union select account_id from web_events;' },
  { name: 'union all', ds: parch, sql: "select 'o' as src, account_id from orders union all select 'w' as src, account_id from web_events;" },
  { name: 'intersect', ds: parch, sql: 'select account_id from orders intersect select account_id from web_events;' },
  { name: 'except', ds: parch, sql: 'select id from accounts except select account_id from orders;' },
  { name: 'row_number / rank / dense_rank', ds: parch, sql: 'select id, account_id, total, row_number() over (partition by account_id order by total desc, id) as rn, rank() over (order by account_id) as rk, dense_rank() over (order by account_id) as drk from orders;' },
  { name: 'running total', ds: parch, sql: 'select id, account_id, total_amt_usd, sum(total_amt_usd) over (partition by account_id order by occurred_at) as running from orders;' },
  { name: 'lag lead', ds: parch, sql: 'select id, account_id, total_amt_usd, lag(total_amt_usd, 1) over (partition by account_id order by occurred_at, id) as prev, lead(total_amt_usd, 1, 0) over (partition by account_id order by occurred_at, id) as nxt from orders;' },
  { name: 'ntile + first/last value', ds: parch, sql: 'select id, total, ntile(4) over (order by total, id) as quartile, first_value(id) over (partition by account_id order by occurred_at) as first_order from orders;' },
  { name: 'rows frame moving avg', ds: parch, sql: 'select id, avg(total_amt_usd) over (order by occurred_at, id rows between 2 preceding and current row) as mov_avg from orders;' },
  { name: 'window over grouped', ds: parch, sql: 'select account_id, sum(total_amt_usd) as spent, rank() over (order by sum(total_amt_usd) desc) as spend_rank from orders group by account_id;' },
  { name: 'extract fields', ds: parch, sql: 'select id, extract(year from occurred_at) as y, extract(month from occurred_at) as m, extract(day from occurred_at) as d, extract(hour from occurred_at) as h, extract(dow from occurred_at) as dow from orders;' },
  { name: 'extract from interval', ds: parch, sql: "select id, extract(day from (occurred_at - timestamp '2016-01-01 00:00:00')) as days_since, extract(hour from (occurred_at - timestamp '2016-01-01 00:00:00')) as h from orders;" },
  { name: 'date_trunc + date_part', ds: parch, sql: "select date_trunc('month', occurred_at) as mo, date_part('year', occurred_at) as yr, count(*) as n from orders group by 1, 2;" },
  { name: 'date arithmetic', ds: parch, sql: 'select id, occurred_at::date as d, occurred_at::date + 30 as plus30 from orders;' },
  { name: 'interval literal', ds: parch, sql: "select id from orders where occurred_at - timestamp '2016-12-01 00:00:00' > interval '10 days';" },
  { name: 'cast forms', ds: parch, sql: "select cast(total as text) as t1, total::text as t2, cast('123' as integer) + 1 as n, occurred_at::date as d from orders where id = 1;" },
  { name: 'concat operator', ds: parch, sql: "select name || ' <' || website || '>' as pretty from accounts;" },
  { name: 'not / parens logic', ds: parch, sql: "select id, name from accounts where not (sales_rep_id = 321500 and name <> 'Walmart');" },
  { name: 'order by nulls', ds: parch, sql: 'select a.name, o.occurred_at from accounts a left join orders o on o.account_id = a.id order by o.occurred_at desc nulls last, a.name;', ordered: true },
  { name: 'capstone union + cte + case', ds: parch, sql: `(select id, total_amt_usd as amount, case when total_amt_usd > 5000 then 'Big order' else 'Wrong' end as label from orders where total_amt_usd > 5000) union (with small_orders as (select id, total_amt_usd from orders where total_amt_usd < 500) select id, total_amt_usd, case when total_amt_usd < 500 then 'Small order' else 'Wrong' end as label from small_orders order by total_amt_usd desc);` },
  { name: 'capstone left join + having subquery', ds: parch, sql: `with acct_orders as (select account_id, count(*) as num_orders from orders group by account_id) select a.sales_rep_id, sum(ao.num_orders) as team_orders from accounts a left join acct_orders ao on ao.account_id = a.id group by a.sales_rep_id having sum(ao.num_orders) > (select avg(num_orders) from acct_orders);` },
  { name: 'capstone lag in cte', ds: parch, sql: `with order_history as (select account_id, occurred_at, total_amt_usd, lag(total_amt_usd, 1) over (partition by account_id order by occurred_at) as previous_amt from orders) select *, (total_amt_usd - previous_amt) as change from order_history where previous_amt is not null;` },
  { name: 'standalone values', ds: parch, sql: "values (1, 'a'), (2, 'b'), (3, null);" },
  { name: 'cte column list over values', ds: parch, sql: `with months(mnum, mname) as (values (1,'January'), (2,'February'), (3,'March')) select r.name, m.mname from region r join months m on m.mnum = r.id order by r.id;`, ordered: true },
  // --- Northwind (DSO 435 class database) — HW1/HW2 style ---
  { name: 'nw select where', ds: northwind, sql: "select productid, productname, unitprice from products where unitprice > 50 and discontinued = 0;" },
  { name: 'nw group by count', ds: northwind, sql: 'select country, count(*) as customers from customers group by country;' },
  { name: 'nw group by having', ds: northwind, sql: 'select categoryid, count(*) as n, round(avg(unitprice)::numeric, 2) as avg_price from products group by categoryid having count(*) >= 10;' },
  { name: 'nw inner join two tables', ds: northwind, sql: "select o.orderid, c.companyname, o.orderdate from orders o join customers c on c.customerid = o.customerid where o.orderdate < '1996-07-15';" },
  { name: 'nw inner join three tables + aggregate', ds: northwind, sql: 'select c.categoryname, sum(od.quantity) as units from orderdetails od join products p on p.productid = od.productid join categories c on c.categoryid = p.categoryid group by c.categoryname;' },
  { name: 'nw join with arithmetic', ds: northwind, sql: 'select od.orderid, sum(od.unitprice * od.quantity * (1 - od.discount)) as order_total from orderdetails od group by od.orderid having sum(od.unitprice * od.quantity * (1 - od.discount)) > 10000;' },
  { name: 'nw self join reportsto', ds: northwind, sql: 'select e.lastname as employee, m.lastname as manager from employees e join employees m on m.employeeid = e.reportsto;' },
  { name: 'nw left join is null', ds: northwind, sql: 'select c.customerid, c.companyname from customers c left join orders o on o.customerid = c.customerid where o.orderid is null;' },
  { name: 'nw order by limit', ds: northwind, sql: 'select orderid, freight from orders order by freight desc, orderid limit 5;', ordered: true },
  { name: 'nw employee territories 3-way', ds: northwind, sql: 'select e.lastname, count(distinct r.regionid) as regions from employees e join employeeterritories et on et.employeeid = e.employeeid join territories t on t.territoryid = et.territoryid join region r on r.regionid = t.regionid group by e.lastname;' },
];

function main() {
  console.log('Setting up scratch database…');
  setupDb();
  let pass = 0;
  const failures: string[] = [];
  for (const c of CASES) {
    let engineRows: string[][];
    try {
      const { result } = runQuery(c.sql, c.ds);
      engineRows = result.rows.map((r) => r.cells.map(engineCell));
      if (result.truncated) {
        // result table is display-capped; refuse to compare partial data
        throw new Error('result truncated in viz — raise MAX_VIZ_ROWS for verify');
      }
    } catch (err) {
      failures.push(`${c.name}: ENGINE ERROR — ${(err as Error).message}`);
      continue;
    }
    let pgRows: string[][];
    try {
      pgRows = pgRun(`set search_path to "${c.ds.id}";\n${c.sql}`);
    } catch (err) {
      failures.push(`${c.name}: POSTGRES ERROR — ${(err as Error).message?.split('\n')[0]}`);
      continue;
    }
    let ok: boolean;
    let detail = '';
    if (c.ordered) {
      ok = engineRows.length === pgRows.length &&
        engineRows.every((r, i) => r.length === pgRows[i].length && r.every((cell, j) => cellsEqual(cell, pgRows[i][j])));
      if (!ok) detail = `engine ${engineRows.length} rows vs pg ${pgRows.length} rows (ordered compare)`;
    } else {
      const a = canon(engineRows);
      const b = canon(pgRows);
      ok = a.length === b.length && a.every((r, i) => {
        if (r === b[i]) return true;
        const ra = r.split(SEP);
        const rb = b[i].split(SEP);
        return ra.length === rb.length && ra.every((cell, j) => cellsEqual(cell, rb[j]));
      });
      if (!ok) detail = `engine ${engineRows.length} rows vs pg ${pgRows.length} rows`;
    }
    if (ok) {
      pass++;
      console.log(`  ✓ ${c.name}`);
    } else {
      failures.push(`${c.name}: MISMATCH — ${detail}`);
      console.log(`  ✗ ${c.name} — ${detail}`);
      const show = (rows: string[][]) => rows.slice(0, 4).map((r) => r.join(' | ')).join('\n      ');
      console.log(`    engine:\n      ${show(engineRows)}`);
      console.log(`    pg:\n      ${show(pgRows)}`);
    }
  }
  console.log(`\n${pass}/${CASES.length} passed`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  execFileSync('dropdb', ['-h', 'localhost', '--if-exists', DB], { encoding: 'utf8' });
  process.exit(failures.length ? 1 : 0);
}

main();
