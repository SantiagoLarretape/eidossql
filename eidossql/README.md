# EidosSQL

**Watch SQL think — one clause at a time.**

> **εἶδος** (*eîdos*) — in ancient Greek, the *form*: the thing seen, the shape
> by which something is known. In modern Greek, a *type* or *kind*. EidosSQL
> makes the form of a query visible — one step, one type, one table at a time.

EidosSQL is an interactive teaching tool built for DSO 435 (Data Base
Management Systems, USC Marshall). Paste in any query from the first half of
the course — joins, grouping, subqueries, CTEs, set operations, window
functions — and it replays the query the way the database actually evaluates
it, as a sequence of animated table states:

1. **FROM** — start with the whole table
2. **JOIN** — watch rows pair up (and see exactly which rows fail to match,
   and what LEFT JOIN does about it)
3. **WHERE** — every row is marked ✓ kept or ✕ dropped, then the dropped rows
   animate away
4. **GROUP BY** — rows are colored by group, then collapse into one row per
   group as aggregates are computed
5. **HAVING** — whole groups pass or fail
6. **Window functions** — partitions are striped and the computed column
   appears, without collapsing rows
7. **SELECT** — only now are columns picked and computed
8. **DISTINCT / UNION / ORDER BY / LIMIT** — dedupe, stack, reorder (with
   FLIP animations), and cut

CTEs, subqueries, and set-operation branches run as *nested* step groups with
breadcrumb badges, so a capstone-level `UNION`-of-`WITH`-of-`CASE` query
unfolds into a story you can step through with arrow keys or play like a
movie. Each step also highlights the clause of the
SQL text it corresponds to, states what happened in plain English with real
row counts, and (where relevant) adds a teaching note — e.g. *why* `WHERE`
can't see column aliases, or what `LIMIT` without `ORDER BY` really promises.

Error messages are teaching-first, too: using an alias in `WHERE`, an
aggregate in `WHERE`, double quotes for a text value, or a subquery in `FROM`
without an alias all produce the hint a TA would give at office hours.

## Datasets

The class teaching database is embedded (no server needed): **Parch &
Posey** — accounts, orders, sales_reps, region, web_events — trimmed to a
referentially-intact sample small enough that every row stays visible on
screen. It keeps the fun edge cases: an account with no orders, a region
with no reps.

A progression of ~20 curated examples mirrors the semester: SELECT basics →
joins → aggregation → subqueries/CTEs → window functions → capstone queries
at end-of-course difficulty.

### Northwind is built in

The **Database** menu also includes **Northwind (DSO 435 class DB)** — the full
course database (830 orders, 2,155 order lines, 91 customers, 77 products),
generated verbatim from the course's `northwind_postgreSQL.sql` so results
match what students see in DBeaver row for row. It works on the hosted
GitHub Pages build with no install, and the example menu has a Northwind
group (joins, GROUP BY/HAVING, left join, self join). Column names are
lowercase, exactly as Postgres folds them (`orderid`, `companyname`).

### …or connect your own database

When running locally, **Database → "Connect your own Postgres…"** points
EidosSQL at any database on your machine — the same ones you use in DBeaver
(`postgres://localhost:5432/northwind`, or just `northwind`). A small bridge
inside the dev server introspects the schema and loads a row sample into the
browser; your connection string never leaves your computer, and the bridge
only reads (its session is forced read-only).

The default loads **all rows** (50,000 per table max; smaller samples are
the opt-in for huge tables). Equality joins use a hash-join path, so
full-size course databases (thousands of rows) compute instantly and
**results match the real database exactly** — and EidosSQL proves it:
every query you run is also executed by your real PostgreSQL (read-only)
and diffed, stamping the result with "✓ Verified — matches your PostgreSQL"
or an honest warning. Intermediate steps display the
first 100 rows, and the final result view shows up to 2,500. If you do load
a sample, EidosSQL labels sampled tables and shows a **query-aware** banner:
it warns only when the query actually reads a sampled table, and turns green
when the query's tables are fully loaded (results exact). The caveat is
itself a good classroom conversation. A work budget in the engine catches runaway queries
(e.g. a cross join of huge tables) with a teaching hint instead of a frozen
tab.

## Running it

```bash
npm install
npm run dev      # then open http://localhost:5173
```

The app is fully client-side, so `npm run build` produces a static `dist/`
that can be hosted anywhere (GitHub Pages, Netlify, …). On a static host
everything works except connecting to your own Postgres, which by nature
requires running locally — the UI explains this if a student tries.

## How it works

EidosSQL contains a from-scratch SQL engine (`src/engine/`) written in
TypeScript: a tokenizer, a recursive-descent parser that attaches source
spans to every clause (that's what powers the editor highlighting), and an
executor that evaluates queries in SQL's logical clause order while emitting
a visualization snapshot at every stage. Rows carry stable identities across
snapshots, which is what lets the UI animate a row's journey (framer-motion
layout animations) instead of just swapping tables.

The engine implements Postgres semantics for the course subset — including
three-valued NULL logic, integer division, `UNION` dedup, default window
frames (running totals include peer rows), `EXTRACT` on timestamp
differences, and correlated subqueries.

### Testing & CI

Three layers, shallowest to deepest:

- `npm test` — 74 Vitest unit tests that run anywhere, no database needed:
  the **teaching-error catalog** (every classic student mistake pinned to
  its message and hint), **step structure** (phase order, kept/dropped row
  marks, stable row identities, timeline source-coloring), value semantics
  (three-valued NULL logic, intervals, grouping keys), CSV parsing/type
  inference, and golden Postgres-semantics results (integer division,
  `NOT IN` with NULL, peer-inclusive running totals, …).
- `npm run verify` — the **differential test**: loads the embedded dataset
  into a scratch local Postgres database, runs a 73-query battery (all join
  types on both planner paths, grouping edge cases, all window function
  classes, set ops, correlated subqueries, date/interval math, capstones)
  through both the engine and Postgres, and diffs results cell-by-cell.
  Current status: **73/73 identical**.
- **CI** (`.github/workflows/ci.yml`) runs all of it on every push:
  typecheck → oxlint → unit tests → the full differential suite against a
  real `postgres:16` service container → production build. A second
  workflow deploys the static build to GitHub Pages on pushes to main
  (enable once in repo Settings → Pages → Source: "GitHub Actions").

## Full documentation

**[docs/MASTER-GUIDE.md](docs/MASTER-GUIDE.md)** — also available as a
40-page formatted report, **[docs/MASTER-GUIDE.pdf](docs/MASTER-GUIDE.pdf)** —
is the complete map of the project:

- **Part I–II** — every user-facing feature, and how each part of the engine
  works (value semantics, parser, step-emitting executor, join planner,
  subquery correlation), plus the Postgres bridge and design system.
- **Part III** — design decisions and trade-offs: for each major choice, the
  alternatives considered, what was chosen, what it cost, and what I'd
  revisit.
- **Part IV** — complexity analysis of every hot path, the measured impact
  of the hash-join rewrite, and the rationale behind each guard rail.
- **Part V–VI** — testing methodology, the bugs differential testing caught,
  known deviations from Postgres, and workflows.
- **Appendices** — an interview Q&A, a glossary of the CS concepts involved,
  annotated excerpts of the trickiest code, and project metrics.

## Project layout

```
src/
  engine/        tokenizer, parser, executor, function library
  data/          embedded course datasets
  ui/            editor, animated table, timeline, schema panel, examples
scripts/
  smoke.ts       quick engine smoke test (npm run smoke)
  verify.ts      engine-vs-Postgres differential test (npm run verify)
```
