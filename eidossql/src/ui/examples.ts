// Curated example queries, ordered as a teaching progression that mirrors the
// first half of the DSO 435 semester — from SELECT basics up to capstone
// queries at end-of-course difficulty.

export interface Example {
  id: string;
  dataset: 'parch';
  group: string;
  label: string;
  sql: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'select-basics', dataset: 'parch', group: '1 · Foundations',
    label: 'SELECT — pick columns',
    sql: `select id, name, website\nfrom accounts;`,
  },
  {
    id: 'where', dataset: 'parch', group: '1 · Foundations',
    label: 'WHERE — filter rows',
    sql: `select name, primary_poc\nfrom accounts\nwhere sales_rep_id = 321500;`,
  },
  {
    id: 'order-limit', dataset: 'parch', group: '1 · Foundations',
    label: 'ORDER BY + LIMIT — top N',
    sql: `select account_id, occurred_at, total_amt_usd\nfrom orders\norder by total_amt_usd desc\nlimit 5;`,
  },
  {
    id: 'case', dataset: 'parch', group: '1 · Foundations',
    label: 'CASE — bucket values',
    sql: `select id, total,\n  case\n    when total > 1000 then 'Large'\n    when total > 300 then 'Medium'\n    else 'Small'\n  end as order_size\nfrom orders;`,
  },
  {
    id: 'join', dataset: 'parch', group: '2 · Joins',
    label: 'JOIN — match two tables',
    sql: `select a.name, o.occurred_at, o.total_amt_usd\nfrom accounts a\njoin orders o on o.account_id = a.id;`,
  },
  {
    id: 'multi-join', dataset: 'parch', group: '2 · Joins',
    label: 'Chained JOINs — three tables',
    sql: `select a.name as account, s.name as rep, r.name as region\nfrom accounts a\njoin sales_reps s on s.id = a.sales_rep_id\njoin region r on r.id = s.region_id;`,
  },
  {
    id: 'left-join', dataset: 'parch', group: '2 · Joins',
    label: 'LEFT JOIN — keep unmatched rows',
    sql: `select a.name, o.id as order_id, o.total_amt_usd\nfrom accounts a\nleft join orders o on o.account_id = a.id;`,
  },
  {
    id: 'left-join-null', dataset: 'parch', group: '2 · Joins',
    label: 'LEFT JOIN + IS NULL — find the gaps',
    sql: `select a.name, o.id as order_id\nfrom accounts a\nleft join orders o on o.account_id = a.id\nwhere o.id is null;`,
  },
  {
    id: 'group-by', dataset: 'parch', group: '3 · Aggregation',
    label: 'GROUP BY — one row per group',
    sql: `select account_id,\n  count(*) as num_orders,\n  sum(total_amt_usd) as total_spent\nfrom orders\ngroup by account_id;`,
  },
  {
    id: 'having', dataset: 'parch', group: '3 · Aggregation',
    label: 'HAVING — filter the groups',
    sql: `select a.name, sum(o.total_amt_usd) as total_spent\nfrom accounts a\njoin orders o on o.account_id = a.id\ngroup by a.name\nhaving sum(o.total_amt_usd) > 5000\norder by total_spent desc;`,
  },
  {
    id: 'in-subquery', dataset: 'parch', group: '4 · Subqueries & CTEs',
    label: 'Subquery with IN',
    sql: `select name\nfrom accounts\nwhere id in (select account_id\n             from web_events\n             where channel = 'facebook');`,
  },
  {
    id: 'scalar-subquery', dataset: 'parch', group: '4 · Subqueries & CTEs',
    label: 'Scalar subquery — vs. the average',
    sql: `select id, account_id, total_amt_usd\nfrom orders\nwhere total_amt_usd > (select avg(total_amt_usd) from orders);`,
  },
  {
    id: 'cte', dataset: 'parch', group: '4 · Subqueries & CTEs',
    label: 'CTE — name an intermediate result',
    sql: `with account_totals as (\n  select account_id, sum(total_amt_usd) as total_spent\n  from orders\n  group by account_id\n)\nselect a.name, t.total_spent\nfrom accounts a\njoin account_totals t on t.account_id = a.id\norder by t.total_spent desc\nlimit 5;`,
  },
  {
    id: 'union', dataset: 'parch', group: '4 · Subqueries & CTEs',
    label: 'UNION — stack two results',
    sql: `select account_id from orders\nunion\nselect account_id from web_events;`,
  },
  {
    id: 'running-total', dataset: 'parch', group: '5 · Window functions',
    label: 'Running total — SUM OVER',
    sql: `select account_id, occurred_at, total_amt_usd,\n  sum(total_amt_usd) over (partition by account_id\n                           order by occurred_at) as running_total\nfrom orders\nwhere account_id in (1001, 1021);`,
  },
  {
    id: 'rank', dataset: 'parch', group: '5 · Window functions',
    label: 'RANK within each region',
    sql: `with spend as (\n  select a.name, r.name as region, sum(o.total_amt_usd) as total\n  from accounts a\n  join sales_reps s on s.id = a.sales_rep_id\n  join region r on r.id = s.region_id\n  join orders o on o.account_id = a.id\n  group by a.name, r.name\n)\nselect name, region, total,\n  rank() over (partition by region order by total desc) as region_rank\nfrom spend;`,
  },
  {
    id: 'lag', dataset: 'parch', group: '5 · Window functions',
    label: 'LAG — compare to the previous row',
    sql: `select account_id, occurred_at, total_amt_usd,\n  lag(total_amt_usd, 1) over (partition by account_id\n                              order by occurred_at) as previous_amt\nfrom orders;`,
  },
  {
    id: 'ntile', dataset: 'parch', group: '5 · Window functions',
    label: 'NTILE — split into quartiles',
    sql: `select id, account_id, total_amt_usd,\n  ntile(4) over (order by total_amt_usd) as spend_quartile\nfrom orders;`,
  },
  {
    id: 'capstone-union', dataset: 'parch', group: '6 · Putting it together',
    label: 'Capstone — UNION + CTE + CASE',
    sql: `(select id, total_amt_usd as amount,\n  case\n    when total_amt_usd > 5000 then 'Big order'\n    else 'Wrong'\n  end as label\nfrom orders\nwhere total_amt_usd > 5000)\nunion\n(with small_orders as (\n  select id, total_amt_usd\n  from orders\n  where total_amt_usd < 500\n)\nselect id, total_amt_usd,\n  case\n    when total_amt_usd < 500 then 'Small order'\n    else 'Wrong'\n  end as label\nfrom small_orders\norder by total_amt_usd desc);`,
  },
  {
    id: 'capstone-having', dataset: 'parch', group: '6 · Putting it together',
    label: 'Capstone — LEFT JOIN + HAVING subquery',
    sql: `with acct_orders as (\n  select account_id, count(*) as num_orders\n  from orders\n  group by account_id\n)\nselect a.sales_rep_id,\n       sum(ao.num_orders) as team_orders\nfrom accounts a\nleft join acct_orders ao on ao.account_id = a.id\ngroup by a.sales_rep_id\nhaving sum(ao.num_orders) > (select avg(num_orders) from acct_orders);`,
  },
  {
    id: 'capstone-lag', dataset: 'parch', group: '6 · Putting it together',
    label: 'Capstone — LAG inside a CTE',
    sql: `with order_history as (\n  select account_id, occurred_at, total_amt_usd,\n    lag(total_amt_usd, 1) over (partition by account_id\n                                order by occurred_at) as previous_amt\n  from orders\n)\nselect *, (total_amt_usd - previous_amt) as change\nfrom order_history\nwhere previous_amt is not null;`,
  },
];
