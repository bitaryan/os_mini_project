'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { io } from 'socket.io-client';
import {
  benchmarkResultSchema,
  serverEventSchema,
  stateSnapshotSchema,
  timelineResourceSchema,
  type BenchmarkResult,
  type ServerEvent,
  type StateSnapshot,
  type TimelineResource,
} from '@printer/contracts';

const simulationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000001';
type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';

export function LiveDashboard({
  apiUrl,
  socketUrl,
  environment,
  initiallyReady,
}: {
  apiUrl: string;
  socketUrl: string;
  environment: string;
  initiallyReady: boolean;
}) {
  const [role, setRole] = useState<Role>('OPERATOR');
  const [state, setState] = useState<StateSnapshot>();
  const [connected, setConnected] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState(
    initiallyReady
      ? 'Loading the committed simulation…'
      : 'Waiting for the API…',
  );
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [timeline, setTimeline] = useState<TimelineResource>();
  const [benchmark, setBenchmark] = useState<BenchmarkResult>();
  const [followLive, setFollowLive] = useState(true);
  const [timelineWindowMs, setTimelineWindowMs] = useState(60_000);
  const [inspectionEndMs, setInspectionEndMs] = useState<number>();
  const [printerFilter, setPrinterFilter] = useState('ALL');
  const [selectedIntervalId, setSelectedIntervalId] = useState<string>();
  const stateRef = useRef<StateSnapshot>(undefined);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `${apiUrl}/api/v1/simulations/${simulationId}/state`,
        { headers: authHeaders(role), cache: 'no-store' },
      );
      if (!response.ok)
        throw new Error(`State request failed (${response.status}).`);
      const body = (await response.json()) as { data: unknown };
      const next = stateSnapshotSchema.parse(body.data);
      stateRef.current = next;
      setState(next);
      const timelineResponse = await fetch(
        `${apiUrl}/api/v1/simulations/${simulationId}/analytics/timeline?fromMs=0`,
        { headers: authHeaders(role), cache: 'no-store' },
      );
      if (timelineResponse.ok) {
        const timelineBody = (await timelineResponse.json()) as {
          data: unknown;
        };
        setTimeline(timelineResourceSchema.parse(timelineBody.data));
      }
      setStale(false);
      setMessage('Committed state synchronized.');
    } catch (error) {
      setConnected(false);
      setMessage(
        error instanceof Error ? error.message : 'State is unavailable.',
      );
    }
  }, [apiUrl, role]);

  useEffect(() => {
    // The effect synchronizes the initial REST snapshot before Socket replay.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const socket = io(`${socketUrl}/simulations`, {
      auth: { userId: actorId, role },
      transports: ['websocket', 'polling'],
    });
    socket.on('connect', () => {
      socket.emit(
        'simulation.subscribe',
        {
          simulationId,
          ...(stateRef.current
            ? {
                lastSeen: {
                  stateVersion: stateRef.current.simulation.stateVersion,
                  eventIndex: 0,
                },
              }
            : {}),
        },
        (acknowledgement: { ok: boolean; data?: { mode: string } }) => {
          setConnected(acknowledgement.ok);
          if (acknowledgement.ok) setMessage('Live state synchronized.');
          if (acknowledgement.data?.mode === 'RESYNC_REQUIRED') void load();
        },
      );
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('simulation.event', (input: unknown) => {
      const parsed = serverEventSchema.safeParse(input);
      if (!parsed.success) return;
      const event = parsed.data;
      setEvents((current) =>
        [
          event,
          ...current.filter((item) => item.eventId !== event.eventId),
        ].slice(0, 40),
      );
      const currentVersion = stateRef.current?.simulation.stateVersion ?? -1;
      if (event.stateVersion < currentVersion) return;
      if (event.type === 'system.snapshot') {
        stateRef.current = event.data;
        setState(event.data);
        setStale(false);
        return;
      }
      if (event.stateVersion > currentVersion + 1) setStale(true);
      void load();
    });
    return () => {
      socket.disconnect();
    };
  }, [load, role, socketUrl]);

  async function command(
    path: string,
    body: unknown,
    {
      versioned = false,
      method = 'POST',
    }: { versioned?: boolean; method?: 'POST' | 'DELETE' } = {},
  ) {
    const response = await fetch(
      `${apiUrl}/api/v1/simulations/${simulationId}${path}`,
      {
        method,
        headers: {
          ...authHeaders(role),
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...(versioned && state
            ? { 'If-Match': `"${state.simulation.stateVersion}"` }
            : {}),
        },
        ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
      },
    );
    const payload = (await response.json()) as {
      error?: { message: string };
    };
    if (!response.ok)
      throw new Error(payload.error?.message ?? 'Command failed.');
    await load();
  }

  async function submitJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      setMessage('Submitting job…');
      await command('/jobs', {
        documentName: String(form.get('documentName')),
        pages: Number(form.get('pages')),
        basePriority: Number(form.get('priority')),
        colorMode: form.get('colorMode'),
        duplex: form.get('duplex') === 'on',
        arrivalDelayMs: 0,
      });
      event.currentTarget.reset();
      setMessage('Job accepted; automation will dispatch it.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Submission failed.');
    }
  }

  async function submitBurst() {
    try {
      await command('/jobs/burst', {
        mode: 'AVAILABLE_CAPACITY',
        seed: 42,
        count: 5,
        arrival: { kind: 'SIMULTANEOUS' },
        pages: { kind: 'UNIFORM', min: 1, max: 8 },
        priority: { kind: 'UNIFORM', min: 10, max: 90 },
        colorRatio: 0.3,
        duplexRatio: 0.5,
        namePrefix: 'Seed 42',
      });
      setMessage('Deterministic five-job burst accepted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Burst failed.');
    }
  }

  async function runComparison(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const algorithms = form.getAll('algorithm').map(String);
    if (algorithms.length === 0) {
      setMessage('Select at least one scheduling algorithm.');
      return;
    }
    try {
      setMessage('Running isolated scheduler comparison…');
      const response = await fetch(
        `${apiUrl}/api/v1/simulations/${simulationId}/benchmarks`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(role),
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            source: { kind: 'CURRENT_SNAPSHOT' },
            algorithms,
            printerModel: {
              count: Number(form.get('printerCount')),
              pagesPerMinute: Number(form.get('pagesPerMinute')),
              supportsColor: true,
              supportsDuplex: true,
            },
            aging: {
              agingIntervalMs: Number(form.get('agingIntervalMs')),
              agingFactor: Number(form.get('agingFactor')),
              priorityCap: 100,
            },
            seed: Number(form.get('seed')),
          }),
        },
      );
      const accepted = (await response.json()) as {
        data?: { statusUrl: string };
        error?: { message: string };
      };
      if (!response.ok || !accepted.data)
        throw new Error(accepted.error?.message ?? 'Benchmark failed.');
      const resultResponse = await fetch(
        `${apiUrl}${accepted.data.statusUrl}`,
        {
          headers: authHeaders(role),
          cache: 'no-store',
        },
      );
      const resultBody = (await resultResponse.json()) as { data: unknown };
      setBenchmark(benchmarkResultSchema.parse(resultBody.data));
      setMessage('Benchmark completed without changing live state.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Benchmark failed.');
    }
  }

  async function exportBenchmark(format: 'json' | 'csv') {
    if (!benchmark) return;
    const response = await fetch(
      `${apiUrl}/api/v1/simulations/${simulationId}/benchmarks/${benchmark.benchmarkId}/export?format=${format}`,
      { headers: authHeaders(role) },
    );
    if (!response.ok) throw new Error('Export failed.');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `benchmark-${benchmark.benchmarkId}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const writable = role !== 'VIEWER';
  const jobs = state?.jobs ?? [];
  const printers = state?.printers ?? [];
  const benchmarkScale = Math.max(
    1,
    ...(benchmark?.evaluations.flatMap((run) =>
      run.jobs.map((job) => job.endMs),
    ) ?? [1]),
  );
  const timelineEndMs = followLive
    ? (timeline?.toMs ?? 0)
    : Math.min(inspectionEndMs ?? timeline?.toMs ?? 0, timeline?.toMs ?? 0);
  const timelineStartMs = timelineWindowMs
    ? Math.max(0, timelineEndMs - timelineWindowMs)
    : 0;
  const timelineScale = Math.max(1, timelineEndMs - timelineStartMs);
  const visibleIntervals =
    timeline?.intervals.filter(
      (interval) =>
        interval.endMs > timelineStartMs &&
        interval.startMs < timelineEndMs &&
        (printerFilter === 'ALL' || interval.printerId === printerFilter),
    ) ?? [];
  const selectedInterval = timeline?.intervals.find(
    (interval) => interval.id === selectedIntervalId,
  );
  const selectedPrinter = printers.find(
    (printer) => printer.id === selectedInterval?.printerId,
  );
  const completedTimings = jobs.flatMap((job) =>
    job.startedAt && job.completedAt
      ? [
          {
            waitMs: Date.parse(job.startedAt) - Date.parse(job.queuedAt),
            turnaroundMs:
              Date.parse(job.completedAt) - Date.parse(job.queuedAt),
          },
        ]
      : [],
  );
  const averageTiming = (field: 'waitMs' | 'turnaroundMs') =>
    completedTimings.length
      ? Math.round(
          completedTimings.reduce((sum, item) => sum + item[field], 0) /
            completedTimings.length,
        )
      : undefined;
  const benchmarkRanks = benchmark
    ? [
        ...new Set(
          benchmark.evaluations.flatMap((run) =>
            run.jobs.map((job) => job.jobId),
          ),
        ),
      ].map((jobId) => ({
        jobId,
        ranks: Object.fromEntries(
          benchmark.evaluations.map((run) => [
            run.metrics.algorithm,
            [...run.jobs]
              .sort(
                (left, right) =>
                  left.startMs - right.startMs ||
                  left.jobId.localeCompare(right.jobId),
              )
              .findIndex((job) => job.jobId === jobId) + 1,
          ]),
        ),
      }))
    : [];
  const queueDepth =
    timeline?.queueDepth.filter(
      (point) =>
        point.timeMs >= timelineStartMs && point.timeMs <= timelineEndMs,
    ) ?? [];
  const queueDepthMax = Math.max(1, ...queueDepth.map((point) => point.depth));
  const queuePoints = queueDepth
    .map(
      (point) =>
        `${((point.timeMs - timelineStartMs) / timelineScale) * 100},${100 - (point.depth / queueDepthMax) * 100}`,
    )
    .join(' ');
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Application">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            SQ
          </span>
          <span>
            Smart Printer
            <span className="brand-subtitle">QUEUE MANAGEMENT</span>
          </span>
        </div>
        <div className="sidebar-section">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <a className="nav-item active" href="#overview">
            ▦ Overview
          </a>
          <a className="nav-item" href="#queue">
            ☷ Queue
          </a>
          <a className="nav-item" href="#printers">
            ▣ Printers
          </a>
          <a className="nav-item" href="#analytics">
            ◫ Analytics
          </a>
          <a className="nav-item" href="#events">
            ⌁ Events
          </a>
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">OS SIMULATION</span>
          <p>Scheduling, synchronization, leases, and recovery—live.</p>
          <span className="mono">WEEK 06 / RELEASE</span>
        </div>
        <div className="sidebar-footer">
          <span className="status-dot connected" /> Simulated printers only
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="topbar-title">
            Workspace / <strong>Live operations</strong>
          </span>
          <label className="role-control">
            Role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option>VIEWER</option>
              <option>OPERATOR</option>
              <option>ADMIN</option>
            </select>
          </label>
          <span className="environment">{environment}</span>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading" id="overview">
            <div>
              <p className="eyebrow">SMART PRINTER QUEUE</p>
              <h1>Live operations</h1>
              <p className="description">
                Committed queue state, printer ownership, and automation in one
                view.
              </p>
            </div>
            <span className="phase-badge">Week 06 / Analytics</span>
          </div>
          <section
            className={`connection-banner ${stale ? 'warning-banner' : ''}`}
            role="status"
          >
            <span
              className={`status-dot ${connected ? 'connected' : 'disconnected'}`}
            />
            <div>
              <strong>
                {stale
                  ? 'Resynchronizing'
                  : connected
                    ? 'Live connection active'
                    : 'API disconnected'}
              </strong>
              <p>{message}</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void load()}
            >
              Refresh snapshot
            </button>
          </section>

          <section className="kpi-grid" aria-label="Simulation metrics">
            <Kpi
              label="Queue"
              value={`${state?.simulation.queueUsed ?? 0}/${state?.simulation.queueCapacity ?? 0}`}
            />
            <Kpi label="Active" value={state?.metrics.activeJobs ?? 0} />
            <Kpi label="Completed" value={state?.metrics.completedJobs ?? 0} />
            <Kpi
              label="P95 wait"
              value={
                state?.metrics.p95WaitMs == null
                  ? '—'
                  : `${state.metrics.p95WaitMs} ms`
              }
            />
            <Kpi
              label="Simulation time"
              value={`${state?.simulation.simulationTimeMs ?? 0} ms`}
            />
          </section>

          {writable ? (
            <section className="control-grid">
              <form
                className="panel compact-panel"
                onSubmit={(event) => void submitJob(event)}
              >
                <div className="panel-header">
                  <h2>Submit print job</h2>
                  <span className="mono">COMMAND</span>
                </div>
                <div className="form-grid">
                  <label>
                    Document name
                    <input
                      required
                      maxLength={120}
                      name="documentName"
                      defaultValue="Operating Systems Notes"
                    />
                  </label>
                  <label>
                    Pages
                    <input
                      required
                      type="number"
                      min="1"
                      max="10000"
                      name="pages"
                      defaultValue="4"
                    />
                  </label>
                  <label>
                    Priority
                    <input
                      required
                      type="number"
                      min="0"
                      max="100"
                      name="priority"
                      defaultValue="50"
                    />
                  </label>
                  <label>
                    Color mode
                    <select name="colorMode">
                      <option>MONO</option>
                      <option>COLOR</option>
                    </select>
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" name="duplex" /> Duplex
                  </label>
                  <button type="submit">Submit job</button>
                </div>
              </form>
              <section className="panel compact-panel">
                <div className="panel-header">
                  <h2>Simulation controls</h2>
                  <span className="mono">
                    v{state?.simulation.stateVersion ?? 0}
                  </span>
                </div>
                <div className="button-stack">
                  <button
                    type="button"
                    onClick={() =>
                      void command(
                        '/actions/pause',
                        {},
                        { versioned: true },
                      ).catch(show(setMessage))
                    }
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void command(
                        '/actions/resume',
                        {},
                        { versioned: true },
                      ).catch(show(setMessage))
                    }
                  >
                    Resume
                  </button>
                  <label>
                    Simulation speed
                    <select
                      value={state?.simulation.speedMultiplier ?? 1}
                      onChange={(event) =>
                        void command(
                          '/actions/resume',
                          { speedMultiplier: Number(event.target.value) },
                          { versioned: true },
                        ).catch(show(setMessage))
                      }
                    >
                      {[0.25, 0.5, 1, 2, 4].map((speed) => (
                        <option key={speed} value={speed}>
                          {speed}×
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void submitBurst()}
                  >
                    Enqueue seed-42 burst
                  </button>
                </div>
                <p className="helper">
                  Burst preview: 5 simultaneous jobs, 1–8 pages, priorities
                  10–90, deterministic seed 42.
                </p>
              </section>
            </section>
          ) : (
            <p className="read-only-banner">
              Viewer mode is read-only. Choose Operator or Admin to reveal
              command controls.
            </p>
          )}

          <section className="panel data-panel" id="queue">
            <div className="panel-header">
              <h2>Live queue</h2>
              <span className="mono">{jobs.length} jobs</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Document</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th>Priority</th>
                    <th>Printer</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.length === 0 ? (
                    <tr>
                      <td colSpan={7}>No jobs yet. Submit one above.</td>
                    </tr>
                  ) : (
                    jobs.map((job) => (
                      <tr key={job.id}>
                        <td>{job.rank ?? '—'}</td>
                        <td>
                          <strong>{job.documentName}</strong>
                          <small>{job.id.slice(0, 8)}</small>
                        </td>
                        <td>
                          <Status value={job.status} />
                        </td>
                        <td>
                          {job.pagesCompleted}/{job.pages}
                        </td>
                        <td>
                          {job.basePriority} → {job.effectivePriority}
                        </td>
                        <td className="mono">
                          {job.assignedPrinterId?.slice(0, 8) ?? '—'}
                        </td>
                        <td>
                          {writable &&
                          !['COMPLETED', 'CANCELLED', 'FAILED'].includes(
                            job.status,
                          ) ? (
                            <button
                              className="text-button"
                              type="button"
                              onClick={() =>
                                void command(
                                  `/jobs/${job.id}`,
                                  {},
                                  { method: 'DELETE' },
                                ).catch(show(setMessage))
                              }
                            >
                              Cancel
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section id="printers">
            <div className="section-heading">
              <h2>Printer fleet</h2>
              <span>{printers.length} simulated devices</span>
            </div>
            <div className="printer-grid">
              {printers.map((printer) => {
                const active = jobs.find(
                  (job) => job.id === printer.activeJobId,
                );
                const percent = active
                  ? (active.pagesCompleted / active.pages) * 100
                  : 0;
                return (
                  <article className="panel printer-card" key={printer.id}>
                    <div className="panel-header">
                      <div>
                        <h2>{printer.name}</h2>
                        <small className="mono">{printer.id.slice(0, 8)}</small>
                      </div>
                      <Status value={printer.status} />
                    </div>
                    <div className="printer-body">
                      <p>
                        {printer.pagesPerMinute} ppm ·{' '}
                        {printer.supportsColor ? 'Color' : 'Mono'} ·{' '}
                        {printer.supportsDuplex ? 'Duplex' : 'Simplex'}
                      </p>
                      <div
                        className="progress-track"
                        aria-label={`${Math.round(percent)} percent complete`}
                      >
                        <span style={{ width: `${percent}%` }} />
                      </div>
                      <p>
                        {active
                          ? `${active.documentName} · ${active.pagesCompleted}/${active.pages}`
                          : 'Idle—ready for work'}
                      </p>
                      <dl>
                        <div>
                          <dt>Mutex</dt>
                          <dd>
                            {printer.mutex.locked ? 'Locked' : 'Released'}
                          </dd>
                        </div>
                        <div>
                          <dt>Fence</dt>
                          <dd>{printer.mutex.fenceToken}</dd>
                        </div>
                        <div>
                          <dt>Waiters</dt>
                          <dd>{printer.mutex.waiters}</dd>
                        </div>
                      </dl>
                      {writable && (
                        <div className="card-actions">
                          <button
                            type="button"
                            className="danger-button"
                            disabled={printer.status !== 'PRINTING' || !active}
                            onClick={() =>
                              void command(`/printers/${printer.id}/faults`, {
                                fault: 'PAPER_JAM',
                                mode: 'IMMEDIATE',
                              }).catch(show(setMessage))
                            }
                          >
                            Jam
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={printer.status !== 'JAMMED'}
                            onClick={() =>
                              void command(
                                `/printers/${printer.id}/actions/recover`,
                                { resumeInterruptedJob: true },
                              ).catch(show(setMessage))
                            }
                          >
                            Recover
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="panel analytics-panel" id="analytics">
            <div className="panel-header">
              <div>
                <p className="eyebrow">SIMULATION TIME</p>
                <h2>Printer Gantt timeline</h2>
              </div>
              <span className="mono">
                {timelineStartMs}—{timelineEndMs} ms
              </span>
            </div>
            <div className="timeline-controls" aria-label="Timeline controls">
              <label>
                Printer
                <select
                  value={printerFilter}
                  onChange={(event) => setPrinterFilter(event.target.value)}
                >
                  <option value="ALL">All printers</option>
                  {printers.map((printer) => (
                    <option value={printer.id} key={printer.id}>
                      {printer.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Window
                <select
                  value={timelineWindowMs}
                  onChange={(event) =>
                    setTimelineWindowMs(Number(event.target.value))
                  }
                >
                  <option value="10000">10 seconds</option>
                  <option value="30000">30 seconds</option>
                  <option value="60000">60 seconds</option>
                  <option value="0">All time</option>
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={!timelineWindowMs || timelineStartMs === 0}
                onClick={() => {
                  setFollowLive(false);
                  setInspectionEndMs(
                    Math.max(
                      timelineWindowMs,
                      timelineEndMs - timelineWindowMs / 2,
                    ),
                  );
                }}
              >
                Pan earlier
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={followLive || timelineEndMs >= (timeline?.toMs ?? 0)}
                onClick={() =>
                  setInspectionEndMs(
                    Math.min(
                      timeline?.toMs ?? 0,
                      timelineEndMs + timelineWindowMs / 2,
                    ),
                  )
                }
              >
                Pan later
              </button>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={followLive}
                  onChange={(event) => {
                    setFollowLive(event.target.checked);
                    if (!event.target.checked)
                      setInspectionEndMs(timelineEndMs);
                  }}
                />{' '}
                Follow live
              </label>
            </div>
            <div className="gantt" aria-label="Printer execution timeline">
              {printers
                .filter(
                  (printer) =>
                    printerFilter === 'ALL' || printer.id === printerFilter,
                )
                .map((printer) => (
                  <div className="gantt-row" key={printer.id}>
                    <strong>{printer.name}</strong>
                    <div className="gantt-track">
                      {visibleIntervals
                        .filter(
                          (interval) =>
                            interval.printerId === printer.id &&
                            interval.kind !== 'MUTEX',
                        )
                        .map((interval) => (
                          <button
                            type="button"
                            className={`gantt-segment gantt-${interval.kind.toLowerCase()}`}
                            key={interval.id}
                            aria-label={`${interval.kind.toLowerCase()} from ${interval.startMs} to ${interval.endMs} milliseconds`}
                            aria-pressed={selectedIntervalId === interval.id}
                            onClick={() => setSelectedIntervalId(interval.id)}
                            style={{
                              left: `${((Math.max(interval.startMs, timelineStartMs) - timelineStartMs) / timelineScale) * 100}%`,
                              width: `${((Math.min(interval.endMs, timelineEndMs) - Math.max(interval.startMs, timelineStartMs)) / timelineScale) * 100}%`,
                            }}
                            title={`${interval.kind} ${interval.startMs}–${interval.endMs} ms`}
                          />
                        ))}
                    </div>
                  </div>
                ))}
              {printers
                .filter(
                  (printer) =>
                    printerFilter === 'ALL' || printer.id === printerFilter,
                )
                .map((printer) => (
                  <div className="gantt-row" key={`mutex-${printer.id}`}>
                    <strong>{printer.name} mutex</strong>
                    <div className="gantt-track mutex-track">
                      {visibleIntervals
                        .filter(
                          (interval) =>
                            interval.printerId === printer.id &&
                            interval.kind === 'MUTEX',
                        )
                        .map((interval) => (
                          <button
                            type="button"
                            className="gantt-segment gantt-mutex"
                            key={interval.id}
                            aria-label={`Mutex held from ${interval.startMs} to ${interval.endMs} milliseconds`}
                            aria-pressed={selectedIntervalId === interval.id}
                            onClick={() => setSelectedIntervalId(interval.id)}
                            style={{
                              left: `${((Math.max(interval.startMs, timelineStartMs) - timelineStartMs) / timelineScale) * 100}%`,
                              width: `${((Math.min(interval.endMs, timelineEndMs) - Math.max(interval.startMs, timelineStartMs)) / timelineScale) * 100}%`,
                            }}
                          />
                        ))}
                    </div>
                  </div>
                ))}
            </div>
            <div className="timeline-legend" aria-label="Timeline legend">
              <span>
                <i className="legend-execution" /> Execution
              </span>
              <span>
                <i className="legend-idle" /> Idle
              </span>
              <span>
                <i className="legend-jam" /> Jam
              </span>
              <span>
                <i className="legend-offline" /> Offline
              </span>
              <span>
                <i className="legend-mutex" /> Mutex held
              </span>
            </div>
            <div className="queue-chart">
              <div>
                <strong>Queue depth</strong>
                <span>
                  {queueDepth.at(-1)?.depth ?? 0} current · {queueDepthMax} peak
                </span>
              </div>
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                role="img"
                aria-label="Queue depth over simulation time"
              >
                <polyline points={queuePoints || '0,100 100,100'} />
              </svg>
            </div>
            <div className="analytics-summary">
              <div>
                <span>Average wait</span>
                <strong>
                  {averageTiming('waitMs') == null
                    ? '—'
                    : `${averageTiming('waitMs')} ms`}
                </strong>
              </div>
              <div>
                <span>Average turnaround</span>
                <strong>
                  {averageTiming('turnaroundMs') == null
                    ? '—'
                    : `${averageTiming('turnaroundMs')} ms`}
                </strong>
              </div>
              <div>
                <span>Selected process state</span>
                <strong>
                  {selectedInterval?.kind ?? 'Select an interval'}
                </strong>
                {selectedInterval && (
                  <small>
                    {selectedPrinter?.name ?? selectedInterval.printerId} · job{' '}
                    {selectedInterval.jobId?.slice(0, 8) ?? 'none'} ·{' '}
                    {selectedInterval.endMs - selectedInterval.startMs} ms
                  </small>
                )}
              </div>
            </div>
            <details>
              <summary>Accessible timeline table</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Printer</th>
                      <th>State</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Job</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleIntervals.map((interval) => (
                      <tr key={`table-${interval.id}`}>
                        <td>
                          {printers.find(
                            (printer) => printer.id === interval.printerId,
                          )?.name ?? interval.printerId}
                        </td>
                        <td>{interval.kind}</td>
                        <td>{interval.startMs} ms</td>
                        <td>{interval.endMs} ms</td>
                        <td className="mono">
                          {interval.jobId?.slice(0, 8) ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          <section className="panel benchmark-panel" id="benchmarks">
            <div className="panel-header">
              <div>
                <p className="eyebrow">ISOLATED WORKLOAD</p>
                <h2>Scheduling comparison</h2>
              </div>
            </div>
            {writable && (
              <form
                className="benchmark-config"
                onSubmit={(event) => void runComparison(event)}
              >
                <fieldset>
                  <legend>Algorithms</legend>
                  {['FCFS', 'SJF', 'PRIORITY_AGING'].map((algorithm) => (
                    <label className="checkbox" key={algorithm}>
                      <input
                        type="checkbox"
                        name="algorithm"
                        value={algorithm}
                        defaultChecked
                      />{' '}
                      {algorithm}
                    </label>
                  ))}
                </fieldset>
                <label>
                  Printers
                  <input
                    name="printerCount"
                    type="number"
                    min="1"
                    max="64"
                    defaultValue={Math.max(1, printers.length)}
                  />
                </label>
                <label>
                  Speed (ppm)
                  <input
                    name="pagesPerMinute"
                    type="number"
                    min="1"
                    max="600"
                    defaultValue="60"
                  />
                </label>
                <label>
                  Aging interval (ms)
                  <input
                    name="agingIntervalMs"
                    type="number"
                    min="1000"
                    max="300000"
                    defaultValue="5000"
                  />
                </label>
                <label>
                  Aging factor
                  <input
                    name="agingFactor"
                    type="number"
                    min="1"
                    max="25"
                    defaultValue="2"
                  />
                </label>
                <label>
                  Seed
                  <input
                    name="seed"
                    type="number"
                    min="0"
                    max="4294967295"
                    defaultValue="42"
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    !jobs.some(
                      (job) =>
                        !['COMPLETED', 'CANCELLED', 'FAILED'].includes(
                          job.status,
                        ),
                    )
                  }
                >
                  Compare current queue
                </button>
              </form>
            )}
            {benchmark ? (
              <>
                <p className="benchmark-meta mono">
                  Engine v{benchmark.engineVersion} · seed {benchmark.seed} ·{' '}
                  {benchmark.jobCount} jobs · {benchmark.printerModel.count}{' '}
                  printers @ {benchmark.printerModel.pagesPerMinute} ppm
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Algorithm</th>
                        <th>Avg wait</th>
                        <th>Median</th>
                        <th>P95</th>
                        <th>Max</th>
                        <th>Turnaround</th>
                        <th>Makespan</th>
                        <th>Utilization</th>
                        <th>Fairness</th>
                        <th>Starved</th>
                      </tr>
                    </thead>
                    <tbody>
                      {benchmark.evaluations.map(({ metrics }) => (
                        <tr key={metrics.algorithm}>
                          <td>
                            <strong>{metrics.algorithm}</strong>
                          </td>
                          <td>{Math.round(metrics.averageWaitMs)} ms</td>
                          <td>{Math.round(metrics.medianWaitMs)} ms</td>
                          <td>{Math.round(metrics.p95WaitMs)} ms</td>
                          <td>{Math.round(metrics.maximumWaitMs)} ms</td>
                          <td>{Math.round(metrics.averageTurnaroundMs)} ms</td>
                          <td>{metrics.makespanMs} ms</td>
                          <td>
                            {(metrics.printerUtilization * 100).toFixed(1)}%
                          </td>
                          <td>{metrics.fairnessIndex.toFixed(3)}</td>
                          <td>{metrics.starvationCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details>
                  <summary>Dispatch rank changes</summary>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Job</th>
                          {benchmark.evaluations.map((run) => (
                            <th key={`rank-head-${run.metrics.algorithm}`}>
                              {run.metrics.algorithm}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {benchmarkRanks.map(({ jobId, ranks }) => (
                          <tr key={`rank-${jobId}`}>
                            <td className="mono">{jobId.slice(0, 8)}</td>
                            {benchmark.evaluations.map((run) => {
                              const rank = ranks[run.metrics.algorithm];
                              const baseline = ranks['FCFS'];
                              return (
                                <td key={`${jobId}-${run.metrics.algorithm}`}>
                                  {rank ?? '—'}
                                  {rank != null &&
                                  baseline != null &&
                                  rank !== baseline
                                    ? ` (${rank < baseline ? '↑' : '↓'}${Math.abs(rank - baseline)})`
                                    : ''}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
                <div
                  className="benchmark-gantt"
                  aria-label="Shared-scale benchmark Gantt comparison"
                >
                  {benchmark.evaluations.map((run) => (
                    <div
                      className="gantt-row"
                      key={`gantt-${run.metrics.algorithm}`}
                    >
                      <strong>{run.metrics.algorithm}</strong>
                      <div className="gantt-track">
                        {run.jobs.map((job) => (
                          <span
                            className="gantt-segment gantt-execution"
                            key={`${run.metrics.algorithm}-${job.jobId}`}
                            tabIndex={0}
                            role="img"
                            aria-label={`${job.jobId.slice(0, 8)} on printer ${job.printer}, ${job.startMs} to ${job.endMs} milliseconds`}
                            style={{
                              left: `${(job.startMs / benchmarkScale) * 100}%`,
                              width: `${((job.endMs - job.startMs) / benchmarkScale) * 100}%`,
                              opacity: 0.45 + (job.printer % 4) * 0.15,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="helper">
                  Lowest average wait:{' '}
                  <strong>
                    {
                      benchmark.evaluations.reduce((best, run) =>
                        run.metrics.averageWaitMs < best.metrics.averageWaitMs
                          ? run
                          : best,
                      ).metrics.algorithm
                    }
                  </strong>
                  . Results describe this workload only; they do not change the
                  live scheduler.
                </p>
                <div className="card-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      void exportBenchmark('json').catch(show(setMessage))
                    }
                  >
                    Export JSON
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      void exportBenchmark('csv').catch(show(setMessage))
                    }
                  >
                    Export CSV
                  </button>
                  <span className="mono">
                    SHA-256 {benchmark.workloadHash.slice(0, 12)}…
                  </span>
                </div>
              </>
            ) : (
              <p className="helper">
                Compare FCFS, SJF, and Priority Aging against an immutable clone
                of the current queue. Live execution is never changed.
              </p>
            )}
          </section>

          <div className="status-grid lower-grid">
            <section className="panel">
              <div className="panel-header">
                <h2>Agent health</h2>
                <span className="mono">CIRCUITS</span>
              </div>
              <dl className="component-list">
                {state?.agents.length ? (
                  state.agents.map((agent) => (
                    <div key={agent.name}>
                      <dt>{agent.name}</dt>
                      <dd>
                        <span
                          className={`status-dot ${agent.health === 'HEALTHY' ? 'connected' : 'disconnected'}`}
                        />
                        {agent.health} · {agent.circuit}
                      </dd>
                    </div>
                  ))
                ) : (
                  <div>
                    <dt>Automation</dt>
                    <dd>Loading</dd>
                  </div>
                )}
              </dl>
              {state?.alerts.map((alert) => (
                <p className="read-only-banner" key={alert.id}>
                  {alert.code}: {alert.message}
                </p>
              ))}
            </section>
            <section className="panel" id="events">
              <div className="panel-header">
                <h2>Committed event stream</h2>
                <span className="mono">LAST {events.length}</span>
              </div>
              <ol className="event-list">
                {events.length === 0 ? (
                  <li>Waiting for live events…</li>
                ) : (
                  events.map((event) => (
                    <li key={event.eventId}>
                      <span className="mono">
                        v{event.stateVersion}.{event.eventIndex}
                      </span>
                      <strong>{event.type}</strong>
                      <time>
                        {new Date(event.occurredAt).toLocaleTimeString()}
                      </time>
                    </li>
                  ))
                )}
              </ol>
            </section>
          </div>
          <footer className="page-footer">
            <span>Smart Printer Queue Management System</span>
            <span>Educational simulation · No physical printing</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function authHeaders(role: Role): Record<string, string> {
  return { 'X-User-Id': actorId, 'X-User-Role': role };
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Status({ value }: { value: string }) {
  return (
    <span className={`status-pill status-${value.toLowerCase()}`}>{value}</span>
  );
}

function show(setMessage: (message: string) => void) {
  return (error: unknown) =>
    setMessage(error instanceof Error ? error.message : 'Command failed.');
}
