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

const DEFAULT_SQL = EXAMPLES.find((e) => e.id === 'having')!.sql;

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

export default function App() {
  const [datasetId, setDatasetId] = useState<string>('parch');
  const [sql, setSql] = useState<string>(DEFAULT_SQL);
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<ErrState | null>(null);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [remote, setRemote] = useState<Dataset | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const playRef = useRef<number | null>(null);

  const allDatasets: Dataset[] = remote ? [...datasets, remote] : datasets;
  const dataset: Dataset = allDatasets.find((d) => d.id === datasetId) ?? datasets[0];

  const visualize = useCallback(
    (sqlText?: string, dsId?: string) => {
      const text = sqlText ?? sql;
      const id = dsId ?? datasetId;
      const ds = (remote ? [...datasets, remote] : datasets).find((d) => d.id === id) ?? datasets[0];
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
    [sql, datasetId, remote],
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

  // keyboard navigation (when not typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⧉</span>
          <span className="brand-name">EidosSQL</span>
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
                if (e.target.value === '__connect') {
                  setShowConnect(true);
                } else {
                  setDatasetId(e.target.value);
                }
              }}
            >
              {allDatasets.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
              <option value="__connect">➕ Connect your own Postgres…</option>
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
                <p className="step-desc">{step.desc}</p>
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
    </div>
  );
}
