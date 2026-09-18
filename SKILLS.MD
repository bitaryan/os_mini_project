# Smart Printer Queue Management System — Agent Skills and Tools

## 1. Tool execution contract

Skills are typed operations exposed to trusted internal agents and, where stated, an authenticated operator interface. All state-changing tools execute through `QueueCoordinator`; callers never mutate arrays, locks, jobs, or printers directly.

```ts
type UUID = string;
type ISODateTime = string;
type Milliseconds = number;

type JobStatus =
  | "QUEUED"
  | "READY"
  | "PRINTING"
  | "PAUSED"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

type PrinterStatus = "READY" | "RESERVED" | "PRINTING" | "JAMMED" | "ERROR" | "OFFLINE";
type SchedulingAlgorithm = "FCFS" | "SJF" | "PRIORITY_AGING";

interface ToolContext {
  actor: { kind: "AGENT" | "OPERATOR" | "SYSTEM"; id: string };
  commandId: UUID;
  correlationId: UUID;
  expectedStateVersion: number;
  requestedAt: ISODateTime;
}

type ToolResult<T> =
  | { ok: true; value: T; stateVersion: number; emittedEventIds: UUID[] }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
      stateVersion: number;
    };

interface QueueJob {
  id: UUID;
  ownerId: UUID;
  documentName: string;
  pages: number;
  pagesCompleted: number;
  colorMode: "MONO" | "COLOR";
  duplex: boolean;
  basePriority: number; // 0..100; larger values run first
  effectivePriority: number;
  status: JobStatus;
  submittedAt: ISODateTime;
  queuedAt: ISODateTime;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  assignedPrinterId?: UUID;
  retryCount: number;
  version: number;
}
```

### Common guarantees

- Validate parameters before lock acquisition.
- Deduplicate by `commandId` and return the original result on replay.
- Acquire locks in the global order `queue -> printer`; never invert it.
- Commit state, append audit record, and enqueue outbound events as one logical transaction.
- Return `STATE_VERSION_CONFLICT` rather than applying a decision to stale state.
- Do not expose lock handles or mutable references in a return value.

## 2. Fault injection skills

### `triggerPaperJam()`

Injects a simulated paper jam for teaching, tests, and demos.

```ts
interface TriggerPaperJamParams {
  printerId: UUID;
  mode: "IMMEDIATE" | "AFTER_CURRENT_PAGE";
  autoRecoverAfterMs?: Milliseconds; // 1_000..300_000
  reason?: string; // max 200 characters
}

interface PaperJamResult {
  printerId: UUID;
  previousStatus: PrinterStatus;
  status: "JAMMED";
  affectedJobId?: UUID;
  recoveryScheduledAt?: ISODateTime;
}

declare function triggerPaperJam(
  context: ToolContext,
  params: TriggerPaperJamParams,
): Promise<ToolResult<PaperJamResult>>;
```

Execution context: operator or test harness; disabled in production unless `ENABLE_FAULT_INJECTION=true` and the actor has `simulation:fault:write`.

Side effects: acquires the target printer mutex through its worker, moves an active job to `PAUSED`, records page progress, changes printer status to `JAMMED`, emits `printer.jammed` and `job.updated`, and schedules optional recovery. If the printer is already jammed, the tool returns the existing jam state without duplicating events.

### `recoverPrinter()`

```ts
interface RecoverPrinterParams {
  printerId: UUID;
  resumeInterruptedJob: boolean;
}

declare function recoverPrinter(
  context: ToolContext,
  params: RecoverPrinterParams,
): Promise<ToolResult<{ printerId: UUID; status: "READY"; resumedJobId?: UUID }>>;
```

Side effects: clears the fault, emits `printer.recovered`, and either resumes the paused job under the same worker or requeues it with retained progress. It refuses recovery from `OFFLINE` unless the printer is separately brought online.

## 3. Queue control skills

### `rebalanceQueue()`

Recomputes ready-queue order using the active scheduler and optionally redistributes only unstarted reservations. It never migrates a printing job.

```ts
interface RebalanceQueueParams {
  reason: "PRINTER_ADDED" | "PRINTER_REMOVED" | "CONFIG_CHANGED" | "OPERATOR_REQUEST";
  dryRun?: boolean;
}

interface QueuePlacement {
  jobId: UUID;
  rank: number;
  recommendedPrinterId?: UUID;
  explanation: string;
}

interface RebalanceQueueResult {
  algorithm: SchedulingAlgorithm;
  previousOrder: UUID[];
  proposedOrder: UUID[];
  placements: QueuePlacement[];
  applied: boolean;
}

declare function rebalanceQueue(
  context: ToolContext,
  params: RebalanceQueueParams,
): Promise<ToolResult<RebalanceQueueResult>>;
```

Side effects: under the queue mutex, refreshes derived priorities and atomically replaces only the ready-queue ordering. `dryRun` reads a snapshot and emits no domain events. An applied change emits `queue.rebalanced` once.

### `cancelJob()`

```ts
interface CancelJobParams {
  jobId: UUID;
  reason?: string;
}

declare function cancelJob(
  context: ToolContext,
  params: CancelJobParams,
): Promise<ToolResult<{ jobId: UUID; status: "CANCELLED"; stoppedAfterPage?: number }>>;
```

Side effects: removes a queued job atomically. For a printing job, sets `cancellationRequestedAt`; the worker stops after the current page, then releases its mutex. Completed, failed, and already cancelled jobs return `INVALID_TRANSITION`.

### `pauseSimulation()` and `resumeSimulation()`

```ts
declare function pauseSimulation(
  context: ToolContext,
  params: { reason?: string },
): Promise<ToolResult<{ pausedAt: ISODateTime }>>;

declare function resumeSimulation(
  context: ToolContext,
  params: { speedMultiplier?: 0.25 | 0.5 | 1 | 2 | 4 },
): Promise<ToolResult<{ resumedAt: ISODateTime; speedMultiplier: number }>>;
```

Side effects: changes the simulation clock only. Locks and assignments remain intact; watchdog stall timers use simulation time and therefore do not fire while paused.

## 4. Scheduler configuration skills

### `adjustAgingFactor()`

```ts
interface AdjustAgingFactorParams {
  agingFactor: number; // integer 1..25 priority points per interval
  agingIntervalMs: Milliseconds; // integer 1_000..300_000
  priorityCap?: number; // integer 1..100, default 100
  starvationWarningMs?: Milliseconds; // 5_000..3_600_000
}

interface AgingConfigResult {
  previous: Required<AdjustAgingFactorParams>;
  current: Required<AdjustAgingFactorParams>;
  configRevision: number;
  affectedQueuedJobs: number;
}

declare function adjustAgingFactor(
  context: ToolContext,
  params: AdjustAgingFactorParams,
): Promise<ToolResult<AgingConfigResult>>;
```

The effective priority at evaluation time `t` is:

\[
P_{effective}(j,t)=\min(P_{cap}, P_{base}(j)+\lfloor\frac{\max(0,t-t_{queued})}{T_{aging}}\rfloor\times F_{aging})
\]

Side effects: validates and persists a new configuration revision, recomputes derived priorities under the queue mutex, and emits `scheduler.config.updated` followed by one `queue.snapshot` rather than one event per job. Base priorities never change.

### `setSchedulingAlgorithm()`

```ts
interface SetSchedulingAlgorithmParams {
  algorithm: SchedulingAlgorithm;
  applyToQueuedJobs: boolean;
}

declare function setSchedulingAlgorithm(
  context: ToolContext,
  params: SetSchedulingAlgorithmParams,
): Promise<ToolResult<{ algorithm: SchedulingAlgorithm; schedulerRevision: number }>>;
```

Side effects: updates the scheduler revision. If `applyToQueuedJobs` is true, queued jobs are reordered atomically; running jobs are never preempted.

## 5. Analysis skills

### `evaluateScheduler()`

Runs one or more deterministic simulations on a workload snapshot without touching the live queue.

```ts
interface BenchmarkJob {
  id: UUID;
  arrivalTimeMs: number;
  pages: number;
  priority: number;
  requiredColorMode: "MONO" | "COLOR";
  duplex: boolean;
}

interface EvaluateSchedulerParams {
  algorithms: SchedulingAlgorithm[];
  workload: BenchmarkJob[]; // 1..10_000
  printerCount: number; // 1..64
  pagesPerMinute: number; // 1..600
  aging?: Pick<AdjustAgingFactorParams, "agingFactor" | "agingIntervalMs" | "priorityCap">;
  seed: number;
}

interface AlgorithmEvaluation {
  algorithm: SchedulingAlgorithm;
  averageWaitMs: number;
  medianWaitMs: number;
  p95WaitMs: number;
  averageTurnaroundMs: number;
  makespanMs: number;
  throughputJobsPerMinute: number;
  fairnessIndex: number;
  starvationCount: number;
  utilization: number;
  gantt: Array<{
    printerId: string;
    jobId: UUID;
    startMs: number;
    endMs: number;
  }>;
}

declare function evaluateScheduler(
  context: Omit<ToolContext, "expectedStateVersion">,
  params: EvaluateSchedulerParams,
): Promise<ToolResult<{ workloadHash: string; evaluations: AlgorithmEvaluation[] }>>;
```

Fairness uses Jain's index over inverse normalized waits `x_i = 1 / (1 + wait_i)`:

\[
J(x)=\frac{(\sum_{i=1}^{n}x_i)^2}{n\sum_{i=1}^{n}x_i^2}
\]

Execution context: metrics agent or authenticated operator. Side effects are limited to storing the benchmark result and emitting `benchmark.completed`; the active simulation state and state version do not change.

### `getQueueSnapshot()`

```ts
interface QueueSnapshot {
  stateVersion: number;
  capturedAt: ISODateTime;
  algorithm: SchedulingAlgorithm;
  jobs: ReadonlyArray<Readonly<QueueJob>>;
  printerIds: readonly UUID[];
}

declare function getQueueSnapshot(
  context: Pick<ToolContext, "actor" | "correlationId">,
  params: { statuses?: JobStatus[] },
): Promise<ToolResult<QueueSnapshot>>;
```

This read tool returns a deep immutable snapshot and has no shared-state side effects.

## 6. Watchdog and lock recovery skills

### `inspectMutex()`

```ts
interface MutexInspection {
  resourceId: string;
  locked: boolean;
  ownerWorkerId?: UUID;
  leaseId?: UUID;
  acquiredAt?: ISODateTime;
  expiresAt?: ISODateTime;
  fenceToken: number;
  waiters: number;
}

declare function inspectMutex(
  context: Pick<ToolContext, "actor" | "correlationId">,
  params: { resourceId: `printer:${string}` | "queue" },
): Promise<ToolResult<MutexInspection>>;
```

### `forceReleaseMutex()`

```ts
interface ForceReleaseMutexParams {
  printerId: UUID;
  fencedLeaseId: UUID;
  expectedFenceToken: number;
  recoveryAction: "REQUEUE_JOB" | "FAIL_JOB";
}

declare function forceReleaseMutex(
  context: ToolContext,
  params: ForceReleaseMutexParams,
): Promise<ToolResult<{ printerId: UUID; newFenceToken: number; recoveredJobId?: UUID }>>;
```

Execution context: Watchdog only. Side effects occur only after the old lease is expired and fenced. The tool releases the simulated mutex, transitions the printer to `ERROR`, recovers the job, and emits a critical audit event. It is intentionally unavailable to browser clients.

## 7. Error taxonomy

| Code | Meaning | Retry |
|---|---|---|
| `VALIDATION_ERROR` | Parameter shape or range is invalid. | No; correct input. |
| `NOT_FOUND` | Job, printer, or configuration does not exist. | No. |
| `FORBIDDEN` | Actor lacks the required permission. | No. |
| `STATE_VERSION_CONFLICT` | Snapshot is stale. | Yes, after reread. |
| `RESOURCE_BUSY` | Mutex or reservation could not be obtained in time. | Yes, bounded backoff. |
| `INVALID_TRANSITION` | Requested lifecycle transition is illegal. | No. |
| `INVARIANT_VIOLATION` | Operation would corrupt queue/printer ownership. | No; alert operator. |
| `CIRCUIT_OPEN` | Agent is temporarily suppressing operations. | Yes, after retry time. |
| `FAULT_INJECTION_DISABLED` | Demo fault controls are disabled. | No. |

## 8. Security and audit requirements

Operator tools require an authenticated session and CSRF protection. Agent identities use service credentials scoped to their listed skills. Tool inputs are validated with shared Zod schemas; document names are treated as data and never evaluated. Audit records are append-only and include redacted parameters, outcome, duration, state versions, correlation ID, and actor. Rate limits apply independently to mutation, fault-injection, and benchmark tools.
