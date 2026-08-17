# EidosSQL — Demo runbook

*How to run the app locally and demo it over Zoom (or in person). Keep this
open on a second screen or your phone during the call.*

---

## 1. Before the call (5 minutes, do it early — not at 1:58 for a 2:00 call)

**Start the app:**

```bash
cd "/Users/santiagolarretape/IdeaProjects/DSO 435 Visualizing Lessons/eidossql"
npm run dev
```

Open the URL the terminal prints (normally `http://localhost:5173` — if that
port is busy, Vite picks the next one and prints it; use whatever it says).
Leave the terminal running for the whole call; `Ctrl+C` stops the server
afterward.

**Warm it up and set the stage:**

1. Load **Examples → "HAVING — filter the groups"** once and step through it
   so you know everything works.
2. Click **☀️ (light theme)** — light mode reads far better over compressed
   Zoom video and on projectors.
3. Click **🎬 Present** — bigger type, editor collapses to the highlighted
   query strip. This is the mode built for exactly this moment.
4. Browser: hide the bookmarks bar (⌘⇧B), close other tabs, and set page
   zoom to 110–125% (⌘+) — Zoom compression eats small text.
5. Mac: turn on **Do Not Disturb** so notifications don't land mid-demo.

**If you plan to show the connect-your-own-database part:** make sure your
local Postgres is running (the same one DBeaver uses). Test it before the
call: Database → "➕ Connect your own Postgres…" → `parch` → Connect.

**Zoom settings:** share the **browser window**, not the entire screen
(no stray notifications, no dock). The animations are gentle CSS motion —
no special "optimize for video" setting needed.

---

## 2. The demo itself (~8 minutes)

The one rule: **let the animation talk.** Every time you advance a step,
pause a beat before speaking — the motion *is* the explanation.

### Beat 1 — the hook (45 seconds, say almost nothing)

Load **"HAVING — filter the groups"**. Press **Play** and let all eight
steps run once without narrating. Then:

> "This is the query you draw on the whiteboard in office hours — join,
> group, filter the groups. The app draws it instead, and it never gets
> tired of drawing it."

### Beat 2 — the join, and Mattel (90 seconds)

Arrow back (←) to the **JOIN** step. Point at the red ✕ row:

> "Mattel has no orders. Watch what an inner join does to it — it's marked
> 'no match — removed by INNER JOIN' and then it's gone. If this were a
> LEFT JOIN it would survive with NULLs. That's the entire inner-vs-outer
> distinction, *shown* instead of described."

If she bites, load "LEFT JOIN — keep unmatched rows" and show Mattel
surviving as the blue + row full of NULLs.

### Beat 3 — GROUP BY collapses (60 seconds)

Forward to **GROUP BY**, then **COLLAPSE**:

> "Thirty rows get colored by group, then each group collapses into exactly
> one row while the SUM is computed across the rows it swallowed. Students
> who see this stop writing `SELECT name` without grouping by it — they can
> see there's no single row left to take a name from."

### Beat 4 — SELECT comes last (30 seconds)

Forward to **SELECT**:

> "Notice we're at step six of eight. SELECT is nearly the *last* thing the
> database does — which is why WHERE can't use a column alias. The app can
> finally make that rule feel obvious instead of arbitrary."

### Beat 5 — the capstone and the colored timeline (90 seconds)

Load **"Capstone — LEFT JOIN + HAVING subquery"**. Don't step yet — point
at the chip row at the bottom:

> "Sixteen steps, and the chips are colored by which table each step works
> on. Blue steps are inside the CTE reading `orders`. This green chip is the
> CTE itself. The join chip is half-and-half — accounts on one side, the CTE
> on the other. And these green ones near the end are the subquery inside
> HAVING — you can see it reads the CTE without re-reading the query."

Then Play it through. The subquery producing its value ("Subquery result:
2.72…") right before HAVING uses it is the moment that usually lands.

### Beat 6 — break something on purpose (45 seconds)

Exit Present mode (Esc), edit the HAVING example: change the last line's
condition to use the alias — `having total_spent > 5000` — and Visualize:

> "And when a student gets it wrong the way they always get it wrong, it
> doesn't say 'column does not exist.' It explains that WHERE and HAVING run
> *before* SELECT names its outputs, and suggests the fix. The error
> messages are the office-hours answers, written down."

### Beat 7 — their data, not toy data (60 seconds, needs Postgres running)

> "The built-in dataset is a hand-trimmed slice of Parch & Posey so every
> row fits on screen. But it's not limited to that —"

Database → "➕ Connect your own Postgres…" → `parch` → **all rows** →
Connect. Run the HAVING example on the full 6,912-order table:

> "— full class database, real result, computed in milliseconds. And for
> students who don't have Postgres set up, they can load plain CSV files
> instead; it all parses in the browser."

### Beat 8 — the ask (60 seconds)

> "Two ways students could use it: a hosted link — nothing to install, works
> for lecture and homework — or they clone it and point it at their own
> database. Before I put it anywhere, I wanted your read: would this help in
> lecture? Office hours? What's missing for your course?"

Asking for her input, rather than presenting a finished thing, is what turns
this from a surprise into a collaboration.

---

## 3. Questions she may ask, and honest answers

| Question | Answer |
|---|---|
| "Is it accurate?" | Differential-tested against real PostgreSQL: 61 queries diffed cell-by-cell, 61/61 identical — re-verified automatically on every change. |
| "What SQL does it cover?" | Everything in the first half of the course: all joins, grouping, HAVING, subqueries (incl. correlated), CTEs, set operations, window functions with frames, CASE, date math. SELECT only — no INSERT/UPDATE/DDL. |
| "Can it handle student mistakes?" | That's half the product — 37 curated error explanations written the way a TA would say them. |
| "How do students get it?" | Hosted link (once published) or `git clone` + `npm run dev` for the own-database features. CSVs work everywhere. |
| "Can I use my own examples?" | Yes — type any query, connect any local Postgres, or hand out CSVs. |
| "What did you build it with?" | TypeScript/React; the SQL engine is written from scratch (~3,800 lines) because existing engines can't expose intermediate states. |

---

## 4. Troubleshooting

- **`npm run dev` fails with "Cannot find native binding"** — the known npm
  optional-deps bug. Fix:
  `npm install --no-save @rolldown/binding-darwin-arm64@<rolldown version>`
  (check the version with `node -p "require('rolldown/package.json').version"`
  from inside `eidossql/`). Worst case: delete `node_modules` +
  `package-lock.json`, `npm install`, then the command above.
- **Port 5173 busy** — Vite picks the next port automatically; use the URL
  it prints.
- **Connect-to-Postgres fails** — is the Postgres server actually running?
  (Same one DBeaver connects to.) The dialog's error message says what's
  wrong: unreachable server vs. bad database name vs. auth.
- **Fresh machine / re-clone** — run `npm install` once before `npm run dev`.

---

*A shorter 5-minute in-person variant of this script is in the Master Guide,
§21.*
