import { useState, useEffect, useCallback, useRef } from 'react';
import { runQuery, SqlError } from './engine';
import type { Step } from './engine';
import { datasets } from './data/datasets';
import type { Dataset } from './data/datasets';
import { EXAMPLES } from './ui/examples';
import { Editor } from './ui/Editor';
import { StepTable } from './ui/StepTable';
import { Timeline } from './ui/Timeline';
import { SchemaPanel } from './ui/SchemaPanel';
import { ConnectPanel } from './ui/ConnectPanel';
import { CsvPanel } from './ui/CsvPanel';
import { SqlView } from './ui/SqlView';
import { AnimatedDesc } from './ui/AnimatedDesc';

const DEFAULT_SQL = EXAMPLES.find((e) => e.id === 'having')!.sql;
const THEME_KEY = 'eidossql.theme';

interface RunState {
  steps: Step[];
  sql: string;
  datasetId: string;
}

interface ErrState {
  message: string;
  hint?: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

function lineColOf(sql: string, pos: number): { line: number; col: number } {
  const upto = sql.slice(0, pos);
  const line = (upto.match(/\n/g)?.length ?? 0) + 1;
  const col = pos - (upto.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* ignore */ }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The wordmark "E" as a Doric column: capital, fluted shaft, stepped base. */
function ColumnE() {
  return (
    <svg className="brand-e" viewBox="0 0 22 26" aria-hidden="true" fill="currentColor">
      <rect x="0" y="0" width="22" height="3.6" rx="1" />
      <rect x="1.6" y="4.6" width="17" height="2.6" rx="1" />
      <rect x="0" y="0" width="4.6" height="26" rx="1" />
      <rect x="1.6" y="11.7" width="13.5" height="2.8" rx="1" />
      <rect x="1.6" y="18.8" width="17" height="2.6" rx="1" />
      <rect x="0" y="22.4" width="22" height="3.6" rx="1" />
    </svg>
  );
}

export default function App() {
  const [datasetId, setDatasetId] = useState<string>('parch');
  const [sql, setSql] = useState<string>(DEFAULT_SQL);
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<ErrState | null>(null);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [remote, setRemote] = useState<Dataset | null>(null);
  const [csvDs, setCsvDs] = useState<Dataset | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [showCsv, setShowCsv] = useState(false);
  const [present, setPresent] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const playRef = useRef<number | null>(null);

  const allDatasets: Dataset[] = [
    ...datasets,
    ...(remote ? [remote] : []),
    ...(csvDs ? [csvDs] : []),
  ];
  const dataset: Dataset = allDatasets.find((d) => d.id === datasetId) ?? datasets[0];

  // manual theme (overrides the OS setting; persisted)
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch { /* ignore */ }
  }, [theme]);

  const visualize = useCallback(
    (sqlText?: string, dsId?: string) => {
      const text = sqlText ?? sql;
      const id = dsId ?? datasetId;
      const all = [
        ...datasets,
        ...(remote ? [remote] : []),
        ...(csvDs ? [csvDs] : []),
      ];
      const ds = all.find((d) => d.id === id) ?? datasets[0];
      setPlaying(false);
      try {
        const { steps } = runQuery(text, ds);
        setRun({ steps, sql: text, datasetId: id });
        setError(null);
        setCur(0);
      } catch (err) {
        if (err instanceof SqlError) {
          setError({
            message: err.message,
            hint: err.hint,
            start: err.start,
            end: err.end,
            ...lineColOf(text, err.start),
          });
        } else {
          setError({ message: (err as Error).message, start: 0, end: 0, line: 1, col: 1 });
        }
        setRun(null);
        setCur(0);
      }
    },
    [sql, datasetId, remote, csvDs],
  );

  const loadExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    setDatasetId(ex.dataset);
    setSql(ex.sql);
    setError(null);
    visualize(ex.sql, ex.dataset);
  };

  const steps = run?.steps ?? [];
  const step = steps[cur];
  const stale = run !== null && (run.sql !== sql || run.datasetId !== datasetId);

  // playback
  useEffect(() => {
    if (!playing) return;
    if (cur >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    playRef.current = window.setTimeout(() => setCur((c) => c + 1), 2400 / speed);
    return () => {
      if (playRef.current) window.clearTimeout(playRef.current);
    };
  }, [playing, cur, steps.length, speed]);

  // keyboard: arrows step, Esc exits presentation mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPresent(false);
        return;
      }
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        setCur((c) => Math.min(c + 1, steps.length - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPlaying(false);
        setCur((c) => Math.max(c - 1, 0));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steps.length]);

  return (
    <div className={`app${present ? ' presenting' : ''}`}>
      <header className="topbar">
        <div className="brand" aria-label="EidosSQL">
          <span className="brand-name">
            <ColumnE />
            <span aria-hidden="true">idosSQL</span>
          </span>
          <span className="brand-tag">
            <span className="brand-greek" title="eîdos — the form, the thing seen">εἶδος</span>
            {' · '}watch SQL think — one clause at a time
          </span>
        </div>
        <div className="topbar-controls">
          <label className="ctl">
            <span>Database</span>
            <select
              value={datasetId}
              onChange={(e) => {
                if (e.target.value === '__connect') setShowConnect(true);
                else if (e.target.value === '__csv') setShowCsv(true);
                else setDatasetId(e.target.value);
              }}
            >
              {allDatasets.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
              <option value="__connect">➕ Connect your own Postgres…</option>
              <option value="__csv">📄 Load CSV files…</option>
            </select>
          </label>
          <label className="ctl">
            <span>Examples</span>
            <select value="" onChange={(e) => e.target.value && loadExample(e.target.value)}>
              <option value="">Load an example…</option>
              {[...new Set(EXAMPLES.map((e) => e.group))].map((g) => (
                <optgroup key={g} label={g}>
                  {EXAMPLES.filter((e) => e.group === g).map((e) => (
                    <option key={e.id} value={e.id}>{e.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button
            className="icon-btn"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="toggle theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button
            className={`icon-btn present-btn${present ? ' active' : ''}`}
            onClick={() => setPresent((p) => !p)}
            title={present ? 'Exit presentation mode (Esc)' : 'Presentation mode: big type, no editor'}
          >
            {present ? '✕ Exit' : '🎬 Present'}
          </button>
        </div>
      </header>

      <div className="panes">
        <aside className="left-pane">
          <Editor
            value={sql}
            onChange={setSql}
            onRun={() => visualize()}
            highlight={!stale && step ? step.span : null}
            errorSpan={error ? { start: error.start, end: error.end } : null}
          />
          <div className="run-row">
            <button className="run-btn" onClick={() => visualize()}>
              ▶ Visualize
              <kbd>⌘⏎</kbd>
            </button>
            {stale && <span className="stale-note">edited — run again to update</span>}
          </div>
          {error && (
            <div className="error-box" role="alert">
              <div className="error-title">
                Line {error.line}: {error.message}
              </div>
              {error.hint && <div className="error-hint">💡 {error.hint}</div>}
            </div>
          )}
          <SchemaPanel dataset={dataset} />
        </aside>

        <main className="stage">
          {run && (
            <div className="present-sql">
              <SqlView sql={run.sql} highlight={!stale && step ? step.span : null} />
            </div>
          )}
          {(() => {
            const sampled = dataset.tables.filter((t) => t.totalRows);
            if (!sampled.length) return null;
            const parts = sampled.slice(0, 3).map(
              (t) => `${t.name} ${t.rows.length.toLocaleString()} of ${t.totalRows!.toLocaleString()}`,
            );
            return (
              <div className="sample-banner">
                ⚠️ Working with a sample — {parts.join(', ')}
                {sampled.length > 3 ? `, +${sampled.length - 3} more` : ''} rows loaded.
                Results can differ from the full database.
              </div>
            );
          })()}
          {step ? (
            <>
              <div className="step-head">
                <div className="step-meta">
                  {step.path.map((p, i) => (
                    <span key={i} className="path-badge">{p}</span>
                  ))}
                  <span className="step-counter">
                    step {cur + 1} / {steps.length}
                  </span>
                </div>
                <h2 className="step-title">{step.title}</h2>
                <p className="step-desc">
                  <AnimatedDesc key={step.id} text={step.desc} />
                </p>
                {step.insight && <p className="step-insight">💡 {step.insight}</p>}
              </div>

              <div className="stage-table">
                <StepTable table={step.table} />
              </div>

              <div className="controls">
                <div className="nav-btns">
                  <button
                    onClick={() => { setPlaying(false); setCur((c) => Math.max(0, c - 1)); }}
                    disabled={cur === 0}
                    aria-label="previous step"
                  >
                    ← Prev
                  </button>
                  <button
                    className="play-btn"
                    onClick={() => {
                      if (cur >= steps.length - 1) setCur(0);
                      setPlaying((p) => !p);
                    }}
                  >
                    {playing ? '❚❚ Pause' : '▶ Play'}
                  </button>
                  <button
                    onClick={() => { setPlaying(false); setCur((c) => Math.min(steps.length - 1, c + 1)); }}
                    disabled={cur >= steps.length - 1}
                    aria-label="next step"
                  >
                    Next →
                  </button>
                  <select
                    className="speed"
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    aria-label="playback speed"
                  >
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={1.5}>1.5×</option>
                    <option value={2}>2×</option>
                  </select>
                </div>
                <Timeline steps={steps} current={cur} onSelect={(i) => { setPlaying(false); setCur(i); }} />
              </div>
            </>
          ) : (
            <div className="stage-empty">
              <div className="empty-art">⧉</div>
              <h2>See how SQL really reads your query</h2>
              <p>
                Write a query on the left (or load an example above), then press{' '}
                <strong>Visualize</strong>. EidosSQL replays it the way the database
                thinks: FROM finds the table, JOIN matches rows, WHERE filters,
                GROUP BY collapses, and only then does SELECT pick columns — one
                animated step at a time.
              </p>
              <p className="empty-hint">Use ← → to step through, or press Play.</p>
            </div>
          )}
        </main>
      </div>
      {showConnect && (
        <ConnectPanel
          onClose={() => setShowConnect(false)}
          onConnected={(ds) => {
            setRemote(ds);
            setDatasetId(ds.id);
            setShowConnect(false);
          }}
        />
      )}
      {showCsv && (
        <CsvPanel
          onClose={() => setShowCsv(false)}
          onLoaded={(ds) => {
            setCsvDs(ds);
            setDatasetId(ds.id);
            setShowCsv(false);
          }}
        />
      )}
    </div>
  );
}
