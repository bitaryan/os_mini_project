# REST API and Real-Time Event Contract

## 1. Protocol conventions

### 1.1 Base and media type

- REST base path: `/api/v1`
- JSON media type: `application/json`
- Timestamps: RFC 3339 UTC strings for wall/audit time.
- Simulation durations/timestamps: non-negative integer milliseconds.
- Identifiers: opaque UUID strings; clients must not parse them.
- Unknown request fields are rejected at external boundaries.
- Integer ranges are enforced; `NaN`, infinity, and numeric strings are invalid.

### 1.2 Authentication and authorization

The browser authenticates using the deployment's secure session mechanism. Socket.IO uses the same identity during handshake. Roles:

| Role | Capabilities |
|---|---|
| `VIEWER` | read state/history/metrics/benchmarks; subscribe to authorized simulations |
| `OPERATOR` | viewer rights plus submit/cancel, simulation controls, scheduler changes, fault/recovery tools |
| `ADMIN` | operator rights plus printer/configuration management, reset, audit access |

Cookie-authenticated mutation requests require a CSRF token. All protected calls are scoped to an authorized `simulationId`.

### 1.3 Headers

| Header | Direction | Use |
|---|---|---|
| `Authorization` | request | bearer identity where configured |
| `X-CSRF-Token` | request | required for cookie-authenticated mutations |
| `Idempotency-Key` | request | required for job, burst, benchmark, and mutation commands |
| `X-Correlation-Id` | both | caller-provided valid UUID or server-generated |
| `If-Match` | request | expected state version as quoted ETag for versioned mutations |
| `ETag` | response | state version for snapshots/resources |
| `Retry-After` | response | rate limit, open circuit, or temporary unavailability |

Idempotency records are scoped by actor and route. Reusing a key with a different canonical body returns `409 IDEMPOTENCY_CONFLICT`.

### 1.4 Response envelopes

```ts
interface ApiMeta {
  requestId: string;
  correlationId: string;
  servedAt: string;
  stateVersion?: number;
}

interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

interface ApiErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    fieldErrors?: Record<string, string[]>;
    details?: Record<string, unknown>;
  };
  meta: ApiMeta;
}

interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}
```

Messages are suitable for users but clients branch only on `code`. Internal stack traces, SQL details, and secrets never appear.

## 2. Canonical types

```ts
type UUID = string;
type ISODateTime = string;

type JobStatus =
  | "QUEUED"
  | "READY"
  | "PRINTING"
  | "PAUSED"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

type PrinterStatus =
  | "READY"
  | "RESERVED"
  | "PRINTING"
  | "JAMMED"
  | "ERROR"
  | "OFFLINE";

type SchedulingAlgorithm = "FCFS" | "SJF" | "PRIORITY_AGING";

interface JobResource {
  id: UUID;
  simulationId: UUID;
  ownerId: UUID;
  documentName: string;
  pages: number;
  pagesCompleted: number;
  pagesRemaining: number;
  basePriority: number;
  effectivePriority: number;
  colorMode: "MONO" | "COLOR";
  duplex: boolean;
  status: JobStatus;
  blockReason?: "NO_COMPATIBLE_PRINTER";
  submittedAt: ISODateTime;
  queuedAt: ISODateTime;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  assignedPrinterId?: UUID;
  cancellationRequestedAt?: ISODateTime;
  lastProgressAt?: ISODateTime;
  retryCount: number;
  rank?: number;
  sequence: number;
  version: number;
  schedulerExplanation?: string;
}

interface PrinterResource {
  id: UUID;
  simulationId: UUID;
  name: string;
  status: PrinterStatus;
  pagesPerMinute: number;
  supportsColor: boolean;
  supportsDuplex: boolean;
  activeJobId?: UUID;
  mutex: {
    locked: boolean;
    ownerWorkerId?: UUID;
    leaseId?: UUID;
    acquiredAt?: ISODateTime;
    expiresAt?: ISODateTime;
    fenceToken: number;
    waiters: number;
  };
  version: number;
}

interface SchedulerConfig {
  algorithm: SchedulingAlgorithm;
  agingIntervalMs: number;
  agingFactor: number;
  priorityCap: number;
  starvationWarningMs: number;
  revision: number;
}

interface SimulationResource {
  id: UUID;
  status: "RUNNING" | "PAUSED" | "DEGRADED";
  simulationTimeMs: number;
  speedMultiplier: 0.25 | 0.5 | 1 | 2 | 4;
  queueCapacity: number;
  queueUsed: number;
  stateVersion: number;
  scheduler: SchedulerConfig;
}

interface MetricsResource {
  sampleWindowMs: number;
  capturedAt: ISODateTime;
  queuedJobs: number;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  throughputJobsPerMinute: number | null;
  averageWaitMs: number | null;
  medianWaitMs: number | null;
  p95WaitMs: number | null;
  averageTurnaroundMs: number | null;
  starvationWarningCount: number;
  printerUtilization: Record<UUID, number>;
}
```

## 3. State and simulation endpoints

### `GET /simulations/:simulationId/state`

Returns one internally consistent snapshot for initial load or resynchronization.

Response `200`:

```ts
interface StateSnapshot {
  simulation: SimulationResource;
  jobs: JobResource[];
  printers: PrinterResource[];
  metrics: MetricsResource;
  agents: Array<{
    name: string;
    health: "HEALTHY" | "DEGRADED" | "STOPPED";
    circuit: "CLOSED" | "OPEN" | "HALF_OPEN";
    lastActionAt?: ISODateTime;
  }>;
  alerts: Array<{
    id: UUID;
    severity: "INFO" | "WARNING" | "CRITICAL";
    code: string;
    message: string;
    raisedAt: ISODateTime;
  }>;
}
```

The response `ETag` is the quoted state version. Jobs include the active buffer and currently running/paused work; completed history is queried separately.

### `POST /simulations/:simulationId/actions/pause`

Operator. Requires `Idempotency-Key` and `If-Match`.

Request: `{ "reason"?: string }` where reason is at most 200 characters.

Response `200`: updated `SimulationResource`. Idempotently pausing an already paused simulation returns the current paused resource.

### `POST /simulations/:simulationId/actions/resume`

Operator. Request:

```ts
interface ResumeSimulationRequest {
  speedMultiplier?: 0.25 | 0.5 | 1 | 2 | 4;
}
```

Response `200`: updated simulation.

### `PATCH /simulations/:simulationId`

Admin. Versioned update to speed or queue capacity.

```ts
interface UpdateSimulationRequest {
  speedMultiplier?: 0.25 | 0.5 | 1 | 2 | 4;
  queueCapacity?: number; // 1..100_000; cannot be below current use
}
```

### `POST /simulations/:simulationId/actions/reset`

Admin and deployment-config gated. Clears active jobs, worker state, alerts, and metrics window; preserves audit. Request must include `{ confirmSimulationId: UUID, preserveHistory: boolean }`. Response `202` with operation ID. Reset cannot be undone through the API.

## 4. Job endpoints

### `POST /simulations/:simulationId/jobs`

Operator or submission-enabled viewer. Requires `Idempotency-Key`.

```ts
interface CreateJobRequest {
  documentName: string; // trimmed, 1..120
  pages: number; // integer, 1..10_000
  basePriority?: number; // integer, 0..100, default 50
  colorMode: "MONO" | "COLOR";
  duplex: boolean;
  arrivalDelayMs?: number; // integer, 0..3_600_000
}
```

Response `202`: `JobResource`. A delayed job is `QUEUED` until its simulated arrival, then becomes `READY` or `BLOCKED`.

### `POST /simulations/:simulationId/jobs/burst`

Operator. Maximum 1,000 generated or explicit jobs per request.

```ts
type Distribution =
  | { kind: "FIXED"; value: number }
  | { kind: "UNIFORM"; min: number; max: number }
  | { kind: "BOUNDED_NORMAL"; min: number; max: number; mean: number; stdDev: number };

interface CreateBurstRequest {
  mode: "ATOMIC" | "AVAILABLE_CAPACITY";
  seed: number; // uint32
  count: number; // 1..1_000
  arrival:
    | { kind: "SIMULTANEOUS" }
    | { kind: "UNIFORM_INTERVAL"; intervalMs: number }
    | { kind: "POISSON"; meanIntervalMs: number };
  pages: Distribution;
  priority: Distribution;
  colorRatio: number; // 0..1
  duplexRatio: number; // 0..1
  namePrefix?: string; // default "Generated Job"
}

interface BurstResult {
  accepted: JobResource[];
  rejected: Array<{ sourceIndex: number; code: ErrorCode; message: string }>;
  seed: number;
  workloadHash: string;
}
```

Response `202`. Atomic capacity failure returns `409` and accepts none. Available-capacity mode returns `202` with per-item rejections.

### `GET /simulations/:simulationId/jobs`

Query parameters:

- `status`: repeatable `JobStatus`;
- `ownerId`: UUID, authorized scope only;
- `printerId`: UUID;
- `active`: boolean;
- `sort`: `submittedAt`, `completedAt`, `priority`, `wait`;
- `direction`: `asc` or `desc`;
- `limit`: 1–200, default 50;
- `cursor`: opaque.

Response `200`: `CursorPage<JobResource>`. Active live queue order comes from rank; history sorting does not mutate scheduling.

### `GET /simulations/:simulationId/jobs/:jobId`

Response `200`: job plus lifecycle timeline:

```ts
interface JobDetail extends JobResource {
  timeline: Array<{
    eventId: UUID;
    type: string;
    occurredAt: ISODateTime;
    simulationTimeMs: number;
    summary: string;
  }>;
  timing: {
    responseMs?: number;
    waitMs?: number;
    serviceMs: number;
    turnaroundMs?: number;
  };
}
```

### `PATCH /simulations/:simulationId/jobs/:jobId`

Operator/owner according to policy. Requires `If-Match` using the job version or request body `expectedJobVersion`.

```ts
interface UpdateJobRequest {
  basePriority: number; // only mutable field; job must be QUEUED/READY/BLOCKED
  expectedJobVersion: number;
}
```

Response `200`: updated job. Emits reorder snapshot when rank changes.

### `DELETE /simulations/:simulationId/jobs/:jobId`

Operator/owner. Requires idempotency and expected version.

- Queued/ready/blocked: response `200`, immediately `CANCELLED`.
- Printing/paused: response `202`, cancellation requested; final event arrives after current page boundary or recovery.
- Already cancelled with same command: original result.
- Completed/failed: `409 INVALID_TRANSITION`.

## 5. Printer endpoints

### `GET /simulations/:simulationId/printers`

Response `200`: all `PrinterResource` values ordered by name then ID.

### `GET /simulations/:simulationId/printers/:printerId`

Response `200`: printer plus recent utilization, active interval, and lock inspection.

### `POST /simulations/:simulationId/printers`

Admin.

```ts
interface CreatePrinterRequest {
  name: string; // 1..80, unique per simulation
  pagesPerMinute: number; // 1..600
  supportsColor: boolean;
  supportsDuplex: boolean;
  initialStatus?: "READY" | "OFFLINE";
}
```

Response `201`: printer.

### `PATCH /simulations/:simulationId/printers/:printerId`

Admin. Allows name/speed/capabilities and requested online status. Removing a capability cannot strand an active job; request returns conflict until the job finishes or is recovered.

### `POST /simulations/:simulationId/printers/:printerId/faults`

Operator; fault-injection gate required.

```ts
interface InjectPrinterFaultRequest {
  fault: "PAPER_JAM" | "WORKER_STALL";
  mode: "IMMEDIATE" | "AFTER_CURRENT_PAGE";
  autoRecoverAfterMs?: number; // 1_000..300_000
  reason?: string;
}
```

Response `202`: printer, affected job ID, and scheduled recovery time if any.

### `POST /simulations/:simulationId/printers/:printerId/actions/recover`

Operator. Request `{ resumeInterruptedJob: boolean }`. Response `200` with recovered printer and optional resumed job.

### `GET /simulations/:simulationId/printers/:printerId/mutex`

Operator. Returns lock inspection data. Lease IDs may be redacted for viewers. Force release has no public HTTP endpoint; it is an internal watchdog skill only.

## 6. Scheduler and metrics endpoints

### `GET /simulations/:simulationId/scheduler`

Response `200`: `SchedulerConfig` plus a human-readable comparator definition.

### `PUT /simulations/:simulationId/scheduler`

Operator, idempotency key, and state version required.

```ts
interface UpdateSchedulerRequest {
  algorithm: SchedulingAlgorithm;
  applyToQueuedJobs: boolean;
  aging?: {
    agingIntervalMs: number; // 1_000..300_000
    agingFactor: number; // integer 1..25
    priorityCap: number; // integer 1..100
    starvationWarningMs: number; // 5_000..3_600_000
  };
}
```

Response `200`: new config and ordered ready-job IDs. Running jobs remain assigned.

### `POST /simulations/:simulationId/scheduler/rebalance`

Operator. Request `{ dryRun: boolean, reason: "CONFIG_CHANGED" | "PRINTER_ADDED" | "PRINTER_REMOVED" | "OPERATOR_REQUEST" }`. Dry run returns old/proposed order without changing state. Applied mode requires `If-Match` and emits `queue.reordered`.

### `GET /simulations/:simulationId/metrics`

Query `windowMs` is bounded from 1,000 to 86,400,000. Response `200`: `MetricsResource`. Unavailable aggregates are `null`.

### `GET /simulations/:simulationId/analytics/timeline`

Queries: `fromMs`, `toMs`, optional `printerId`, `jobId`, and `limit`. Returns Gantt execution intervals, queue-depth points, and mutex intervals. Large results use cursor pagination or time windows.

## 7. Benchmark endpoints

### `POST /simulations/:simulationId/benchmarks`

Operator. Runs outside live state.

```ts
interface BenchmarkRequest {
  source:
    | { kind: "CURRENT_SNAPSHOT" }
    | { kind: "SAVED_WORKLOAD"; workloadId: UUID }
    | { kind: "EXPLICIT"; jobs: Array<{
        id: UUID;
        arrivalTimeMs: number;
        pages: number;
        priority: number;
        colorMode: "MONO" | "COLOR";
        duplex: boolean;
      }> };
  algorithms: SchedulingAlgorithm[];
  printerModel: {
    count: number; // 1..64
    pagesPerMinute: number; // 1..600
    supportsColor: boolean;
    supportsDuplex: boolean;
  };
  aging?: {
    agingIntervalMs: number;
    agingFactor: number;
    priorityCap: number;
  };
  seed: number;
}
```

Response `202`:

```ts
interface BenchmarkAccepted {
  benchmarkId: UUID;
  status: "QUEUED" | "RUNNING";
  workloadHash: string;
  statusUrl: string;
}
```

### `GET /simulations/:simulationId/benchmarks/:benchmarkId`

Returns pending status or completed evaluations with metric matrix and Gantt intervals. Response includes engine version, exact normalized configuration, seed, and workload hash.

### `GET /simulations/:simulationId/benchmarks/:benchmarkId/export`

Query `format=json|csv`. JSON returns the canonical result. CSV returns one summary row per algorithm plus separately named/linked interval output according to response metadata.

## 8. Audit endpoint

### `GET /simulations/:simulationId/audit`

Admin. Filters: `from`, `to`, `actorId`, `actorKind`, `commandType`, `outcome`, `correlationId`, `limit`, `cursor`.

```ts
interface AuditEntry {
  id: UUID;
  occurredAt: ISODateTime;
  simulationId: UUID;
  actor: { kind: "USER" | "AGENT" | "SYSTEM"; id: string };
  commandType: string;
  correlationId: UUID;
  stateVersionBefore: number;
  stateVersionAfter: number;
  outcome: "ACCEPTED" | "REJECTED" | "FAILED";
  reasonCode?: string;
  redactedParameters: Record<string, unknown>;
  durationMs: number;
}
```

## 9. Health endpoints

### `GET /health/live`

Unauthenticated, rate-limited. Returns `200 { status: "alive", version, uptimeSeconds }` while the process is responsive.

### `GET /health/ready`

Used by the platform. Returns `200` only when configuration, database, migrations, coordinator, and invariant state permit traffic. Otherwise `503` with safe component statuses.

## 10. Socket.IO contract

### 10.1 Namespace, path, and connection

- Namespace: `/simulation`
- Default transport path: `/socket.io`
- Handshake auth includes the deployment session/token; secrets must not appear in query strings.
- Server rejects unauthorized origin, identity, or simulation subscription.

### 10.2 Event envelope

```ts
interface SocketEnvelope<TType extends ServerEventType, TData> {
  protocolVersion: 1;
  eventId: UUID;
  type: TType;
  occurredAt: ISODateTime;
  simulationId: UUID;
  correlationId: UUID;
  stateVersion: number;
  eventIndex: number;
  simulationTimeMs: number;
  data: TData;
}

interface SocketAck<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: ErrorCode; message: string; retryable: boolean };
}
```

`eventIndex` orders multiple events committed at one state version. Clients compare `(stateVersion, eventIndex)` and deduplicate with `eventId`.

### 10.3 Client events

#### `simulation.subscribe`

Payload: `{ simulationId: UUID; lastSeen?: { stateVersion: number; eventIndex: number } }`.

Ack:

```ts
type SubscribeAck =
  | { mode: "LIVE"; currentStateVersion: number }
  | { mode: "REPLAY"; fromStateVersion: number; currentStateVersion: number }
  | { mode: "RESYNC_REQUIRED"; snapshotUrl: string; currentStateVersion: number };
```

#### `simulation.unsubscribe`

Payload `{ simulationId }`; ack confirms room departure.

#### `simulation.pause.request`, `simulation.resume.request`, `simulation.speed.request`

Each payload contains `simulationId`, `commandId`, `expectedStateVersion`, and the action-specific values. Authorization and idempotency match REST. Ack reports acceptance; committed state still arrives through server events.

#### `telemetry.preference.set`

Payload `{ simulationId, progressHz: 1 | 2 | 4 | 10 }`. Ack returns the effective rate, which may be lowered by server policy.

#### `client.ping`

Payload `{ sentAt: ISODateTime }`; ack `{ sentAt, serverAt }`.

### 10.4 Server event payloads

```ts
type ServerEventType =
  | "system.snapshot"
  | "system.resync.required"
  | "simulation.updated"
  | "job.created"
  | "job.updated"
  | "job.progressed"
  | "job.completed"
  | "job.cancelled"
  | "job.failed"
  | "queue.reordered"
  | "queue.capacity.updated"
  | "printer.created"
  | "printer.updated"
  | "printer.jammed"
  | "printer.recovered"
  | "mutex.acquired"
  | "mutex.released"
  | "mutex.force_released"
  | "scheduler.config.updated"
  | "metrics.updated"
  | "agent.status.updated"
  | "alert.raised"
  | "alert.cleared"
  | "benchmark.completed"
  | "audit.entry.created";
```

| Event | `data` payload |
|---|---|
| `system.snapshot` | `StateSnapshot` |
| `system.resync.required` | `{ expectedNextVersion, currentStateVersion, snapshotUrl }` |
| `simulation.updated` | `SimulationResource` |
| `job.created` | `{ job: JobResource }` |
| `job.updated` | `{ job: JobResource, changedFields: string[] }` |
| `job.progressed` | `{ jobId, printerId, pagesCompleted, pages, percent, leaseFenceToken }` |
| `job.completed` | `{ job: JobResource, waitMs, serviceMs, turnaroundMs }` |
| `job.cancelled` | `{ job: JobResource, stoppedAfterPage?: number }` |
| `job.failed` | `{ job: JobResource, code, retryExhausted: boolean }` |
| `queue.reordered` | `{ orderedJobIds: UUID[], reasons: Record<UUID, string>, schedulerRevision }` |
| `queue.capacity.updated` | `{ used, capacity }` |
| `printer.created` | `{ printer: PrinterResource }` |
| `printer.updated` | `{ printer: PrinterResource, changedFields: string[] }` |
| `printer.jammed` | `{ printer: PrinterResource, affectedJobId?, autoRecoverAt? }` |
| `printer.recovered` | `{ printer: PrinterResource, resumedJobId? }` |
| `mutex.acquired` | `{ resourceId, ownerWorkerId, acquiredAt, expiresAt, fenceToken, waiters }` |
| `mutex.released` | `{ resourceId, releasedAt, heldForMs, fenceToken }` |
| `mutex.force_released` | `{ resourceId, fencedLeaseId, newFenceToken, recoveredJobId? }` |
| `scheduler.config.updated` | `{ config: SchedulerConfig, appliedToQueuedJobs: boolean }` |
| `metrics.updated` | `MetricsResource` |
| `agent.status.updated` | `{ name, health, circuit, lastActionAt?, reason? }` |
| `alert.raised` | `{ alert: { id, severity, code, message, raisedAt, resourceId? } }` |
| `alert.cleared` | `{ alertId, clearedAt }` |
| `benchmark.completed` | `{ benchmarkId, workloadHash, summaryUrl }` |
| `audit.entry.created` | `{ auditEntryId, commandType, actorKind, outcome }` |

`leaseFenceToken` is included in operator telemetry for diagnosis but may be omitted from viewer payloads.

### 10.5 Ordering, replay, and backpressure

- Delivery is at least once; clients must be idempotent.
- Lifecycle commits are ordered per simulation by state version and event index.
- Duplicate/older events are ignored.
- A nonconsecutive version triggers `system.resync.required`; clients stop applying mutations until snapshot replacement.
- Durable replay is bounded by retention. Older reconnects receive a snapshot URL.
- Progress frames can be coalesced to the newest committed page per job for a slow client.
- Job terminal, printer fault, mutex force-release, scheduler, alert, and audit events are never intentionally coalesced or dropped.
- On reconnect, clients resubscribe with the last fully applied tuple.

## 11. Error catalog

```ts
type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "STATE_VERSION_CONFLICT"
  | "JOB_VERSION_CONFLICT"
  | "QUEUE_CAPACITY_EXCEEDED"
  | "INVALID_TRANSITION"
  | "NO_COMPATIBLE_PRINTER"
  | "RESOURCE_BUSY"
  | "LOCK_NOT_OWNED"
  | "LEASE_EXPIRED"
  | "FENCE_TOKEN_MISMATCH"
  | "INVARIANT_VIOLATION"
  | "FAULT_INJECTION_DISABLED"
  | "CIRCUIT_OPEN"
  | "RATE_LIMITED"
  | "BENCHMARK_LIMIT_EXCEEDED"
  | "PERSISTENCE_UNAVAILABLE"
  | "RESYNC_REQUIRED"
  | "INTERNAL_ERROR";
```

| HTTP | Codes | Client action |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | correct fields; do not retry unchanged |
| 401 | `UNAUTHENTICATED` | reauthenticate |
| 403 | `FORBIDDEN`, `FAULT_INJECTION_DISABLED` | do not retry without changed permission/config |
| 404 | `NOT_FOUND` | refresh or return to collection |
| 409 | version, idempotency, capacity, transition, resource/lock conflicts | inspect code; refresh and retry only if marked retryable |
| 413 | burst/body limit | reduce request |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | send JSON |
| 422 | domain constraint such as no compatible configuration | change configuration |
| 429 | `RATE_LIMITED` | honor `Retry-After` |
| 503 | persistence unavailable, circuit open, invariant violation | honor retry policy; show degraded state |
| 500 | `INTERNAL_ERROR` | report correlation ID; bounded retry for safe idempotent call |

Example:

```json
{
  "error": {
    "code": "STATE_VERSION_CONFLICT",
    "message": "The simulation changed before this command was applied.",
    "retryable": true,
    "details": { "expected": 41, "actual": 43 }
  },
  "meta": {
    "requestId": "ff8c0bb7-3396-48ba-b4de-b775203c1e0e",
    "correlationId": "6ad362ff-a823-4771-85e8-0f57ec40bd08",
    "servedAt": "2026-09-18T12:00:00.000Z",
    "stateVersion": 43
  }
}
```

## 12. Versioning and compatibility

Breaking REST changes require a new URL version. Additive optional fields and new event types are non-breaking; clients must ignore unknown response fields and event types while still rejecting unknown request fields. Socket envelopes carry `protocolVersion`; incompatible clients receive a clear connection error or resync instruction. Deprecations are documented with removal release/date and observed usage before removal.

Executable Zod schemas in `packages/contracts` are the contract source. Documentation examples, OpenAPI output, server validation, client types, and protocol fixtures must be generated from or tested against those schemas to prevent drift.
