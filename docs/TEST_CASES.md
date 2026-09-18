# Quality Assurance and Test Cases

## 1. Test strategy

Testing proves both application behavior and the OS invariants the simulator teaches. The suite is layered so pure scheduling errors fail quickly, synchronization errors are exercised with controlled interleavings, protocol errors are caught at boundaries, and a small number of browser tests validate integrated behavior.

### 1.1 Test levels

| Level | Tools | Scope |
|---|---|---|
| Unit | Vitest | scheduler functions, clock, metrics, reducers, schemas |
| Domain integration | Vitest | queue coordinator, mutexes, workers, agents, persistence fakes |
| HTTP integration | Supertest | routes, auth, idempotency, errors, transactions |
| Socket integration | Socket.IO client + real test server | ordering, rooms, reconnect, resync, backpressure |
| Component | Testing Library | forms, queue table, badges, accessible chart alternatives |
| End to end | Playwright | complete user journeys against built services |
| Load/stress | k6 or scripted Node clients | bursts, concurrent commands, many live clients |

All time-sensitive domain tests use a fake monotonic simulation clock. Tests must not depend on wall-clock sleeps except transport-level smoke tests with bounded timeouts.

## 2. Global invariants

These assertions run after every generated domain command in unit/integration tests:

```ts
function assertSystemInvariants(state: SimulationState): void {
  const activeAssignments = state.printers
    .filter((p) => p.activeJobId)
    .map((p) => p.activeJobId!);

  expect(new Set(activeAssignments).size).toBe(activeAssignments.length);
  expect(state.printers.every((p) => !p.activeJobId || p.status === "PRINTING" || p.status === "JAMMED")).toBe(true);
  expect(state.jobs.every((j) => j.pagesCompleted >= 0 && j.pagesCompleted <= j.pages)).toBe(true);
  expect(state.jobs.every((j) => !isTerminal(j.status) || !j.assignedPrinterId)).toBe(true);
  expect(state.activeBufferJobIds.length).toBeLessThanOrEqual(state.queueCapacity);
  expect(state.availablePrinterPermits).toBeGreaterThanOrEqual(0);
  expect(state.availablePrinterPermits).toBeLessThanOrEqual(state.printers.length);
}
```

## 3. Scheduling algorithm unit matrix

| ID | Case | Input / setup | Expected result |
|---|---|---|---|
| SCH-001 | FCFS basic order | arrivals A=0, B=10, C=20 | A, B, C |
| SCH-002 | FCFS equal arrivals | same arrival, sequences 3,1,2 | sequence 1,2,3 |
| SCH-003 | FCFS ignores priority | older low priority, newer high | older selected |
| SCH-004 | FCFS ignores pages | older long, newer short | older selected |
| SCH-005 | SJF basic order | remaining pages 10,2,6; equal speed | 2,6,10 |
| SCH-006 | SJF uses remaining pages | 10-page job has 9 done; new 2-page job | 1 remaining selected |
| SCH-007 | SJF adjusts for speed | compatible printer prediction differs | smallest predicted duration selected |
| SCH-008 | SJF tie | equal predicted burst | earlier arrival, then sequence |
| SCH-009 | SJF compatibility | shortest job requires unavailable color | shortest compatible job selected; incompatible blocked |
| SCH-010 | Priority basic | priorities 10,80,50 | 80 selected |
| SCH-011 | Aging first interval | wait less than interval | effective priority unchanged |
| SCH-012 | Aging interval boundary | wait exactly `T` | priority increases by `F` |
| SCH-013 | Aging multiple intervals | wait `3T + 1` | increase `3F` |
| SCH-014 | Aging cap | base 95, factor 10 | effective priority 100 |
| SCH-015 | Negative wait defense | current time before queued time | wait treated as 0 |
| SCH-016 | Aging tie | same effective priority | earlier arrival then sequence |
| SCH-017 | Missed tick | evaluate directly after `10T` | receives all 10 increments |
| SCH-018 | Base immutability | repeated evaluations | base priority unchanged |
| SCH-019 | Non-preemption | new urgent job while another prints | active job remains; urgent ranks first ready |
| SCH-020 | Empty ready set | no eligible jobs | returns no selection, no mutation |
| SCH-021 | Determinism | same snapshot/config repeated 100 times | identical order/explanations |
| SCH-022 | Large input | 10,000 jobs | correct first selection within performance budget |

### Reference aging example

Given `base=20`, `queuedAt=0`, `now=26,000`, `T=5,000`, `F=3`, and `cap=100`:

\[
P_{effective}=\min(100,20+\lfloor26000/5000\rfloor\times3)=35
\]

The unit fixture must assert exactly `35`.

## 4. Mutex and semaphore integration matrix

| ID | Case | Controlled interleaving | Expected result |
|---|---|---|---|
| SYN-001 | Exclusive printer acquisition | workers A/B acquire same printer | one succeeds; other waits/times out |
| SYN-002 | Parallel different printers | A acquires P1, B acquires P2 | both progress concurrently |
| SYN-003 | FIFO mutex fairness | A holds; B then C wait | acquisition order B then C |
| SYN-004 | Release in failure | worker throws in critical section | `finally` releases lock |
| SYN-005 | Double release | owner releases twice | second rejected; permit unchanged |
| SYN-006 | Non-owner release | different lease attempts release | `LOCK_NOT_OWNED` |
| SYN-007 | Stale progress | fence token incremented before late update | update rejected, page count unchanged |
| SYN-008 | Forced release before fencing | watchdog asks directly | rejected |
| SYN-009 | Forced release after fencing | expired lease and correct token | lock released; job recovered once |
| SYN-010 | Semaphore exhaustion | all printers occupied | next dispatch waits/no negative permits |
| SYN-011 | Permit return on completion | active job completes | exactly one permit returned |
| SYN-012 | Permit return on cancellation | active cancellation reaches boundary | exactly one permit returned |
| SYN-013 | Offline idle printer | remove one ready printer | permit decrements once |
| SYN-014 | Recovery | jammed printer recovers ready | permit added once if unassigned |
| SYN-015 | Lock order | paths instrument acquisition | no `printer -> queue` acquisition |
| SYN-016 | Capacity atomicity | two producers contend for last slot | one accepted, one capacity error |
| SYN-017 | State conflict | two commands use same version | first commits, second conflicts |
| SYN-018 | Long I/O check | repository/socket spies inside lock | no external I/O invoked before release |

## 5. Queue and lifecycle tests

| ID | Scenario | Expected result |
|---|---|---|
| JOB-001 | valid submission | immutable ID/sequence; `QUEUED` then `READY`; one event transaction |
| JOB-002 | pages 0 or 10,001 | validation rejection, no state change |
| JOB-003 | priority below 0/above 100 | validation rejection |
| JOB-004 | duplicate idempotency key and same body | same job and status returned |
| JOB-005 | duplicate key with different body | `IDEMPOTENCY_CONFLICT` |
| JOB-006 | queue at capacity | `QUEUE_CAPACITY_EXCEEDED`, no sequence consumed if policy requires contiguous sequence |
| JOB-007 | queued cancellation | removed from active buffer and terminal `CANCELLED` |
| JOB-008 | active cancellation | cancellation requested; stops after current committed page |
| JOB-009 | complete/cancel race | exactly one terminal transition |
| JOB-010 | priority edit while ready | base changes; effective recomputed; queue reordered |
| JOB-011 | priority edit while printing | `INVALID_TRANSITION` |
| JOB-012 | incompatible printer | `BLOCKED`, returns to `READY` after compatible printer appears |
| JOB-013 | restore mid-page | only previous page boundary restored |
| JOB-014 | terminal update attempt | rejected; terminal record unchanged |

## 6. Concurrency and burst stress tests

### 6.1 Scenarios

| ID | Load | Assertions |
|---|---|---|
| STR-001 | 100 clients submit one job simultaneously into capacity 1,000 | 100 unique jobs, no lost sequence, all acknowledgements |
| STR-002 | 1,200 submissions into empty capacity 1,000 | exactly 1,000 accepted, 200 capacity errors, buffer never exceeds cap |
| STR-003 | 50 clients reuse one idempotency key | exactly one job |
| STR-004 | 1,000-job atomic burst with 999 slots | entire burst rejected, state unchanged |
| STR-005 | 1,000-job partial burst with 999 slots | exactly 999 accepted in source order |
| STR-006 | 64 workers and 1,000 jobs | maximum one active job/printer and one printer/job |
| STR-007 | random cancel/edit/jam/recover during processing | invariants always hold; all commands terminate |
| STR-008 | 20 Socket clients at 10 Hz progress | lifecycle events complete; bounded event lag; no process memory runaway |
| STR-009 | benchmark 10,000 jobs × 3 algorithms | finishes within configured timeout without live-state mutation |
| STR-010 | 30-minute accelerated soak | no leaked locks, timers, listeners, permits, or growing outbox |

### 6.2 Pass thresholds

- Zero invariant violations, deadlocks, unhandled rejections, or duplicate terminal transitions.
- p95 API submit latency below 500 ms under reference burst load.
- Event convergence below 2 seconds p95 under maximum supported clients.
- Heap growth stabilizes after garbage collection during soak; project records the reference ceiling in CI artifacts.
- Stress runs use fixed seeds for reproducibility and record runtime/platform metadata.

## 7. Automation and watchdog interception tests

| ID | Trigger | Expected sequence |
|---|---|---|
| AGT-001 | ready printer + queued job | daemon issues one dispatch command |
| AGT-002 | repeated tick before ack | no duplicate command for printer |
| AGT-003 | simulation paused | no page advancement; watchdog timer frozen |
| AGT-004 | one missed progress window | observe only; no interception |
| AGT-005 | two missed windows | `STUCK_JOB_DETECTED`, fence, force release, recover |
| AGT-006 | stale worker after fence | progress rejected |
| AGT-007 | first/second stall | job requeued with retained page count and incremented retry |
| AGT-008 | third stall | job failed with `WATCHDOG_RETRY_EXHAUSTED` |
| AGT-009 | four force-release attempts in 60 s | watchdog circuit opens; dispatch pauses; alert raised |
| AGT-010 | circuit cooldown and healthy probe | circuit half-opens then closes |
| AGT-011 | load balance equal scores | stable printer ID selects winner |
| AGT-012 | stale candidate snapshot | assignment conflicts and recomputes once |
| AGT-013 | starvation threshold crossed | one warning, no duplicate until severity change |
| AGT-014 | invalid aging update | old configuration remains active |
| AGT-015 | metrics evaluator failure | scheduling continues unaffected |

## 8. REST API tests

Each endpoint tests success, validation failure, unauthenticated, unauthorized, not found, state conflict, rate limit, unexpected error mapping, correlation header, content type, and absence of stack traces.

Key cases:

- `POST /jobs`: idempotency and capacity behavior.
- `POST /jobs/burst`: atomic versus partial acceptance.
- `PATCH /jobs/:id`: version and lifecycle guards.
- `DELETE /jobs/:id`: queued and active policies.
- `/printers/:id/faults` and recovery: operator-only and environment gate.
- scheduler configuration: strict enums/ranges and non-preemption.
- benchmark: workload limit, deterministic output, live-state isolation.
- audit: admin authorization, pagination, redaction.
- state snapshot: internal consistency and ETag/version metadata.

Database failure injection asserts that no successful response or in-memory state advancement occurs when a required transaction fails.

## 9. Socket.IO tests

| ID | Case | Expected result |
|---|---|---|
| SOC-001 | authenticated subscribe | joins authorized simulation room |
| SOC-002 | unauthorized simulation | ack error; room not joined |
| SOC-003 | ordered lifecycle | reducer receives ordered version/index pairs |
| SOC-004 | duplicate event | client applies once |
| SOC-005 | version gap | reducer pauses and fetches snapshot |
| SOC-006 | reconnect within replay window | missing events replayed then live resumes |
| SOC-007 | reconnect beyond replay window | `system.resync.required` |
| SOC-008 | slow client | progress coalesced; terminal/alert retained |
| SOC-009 | room isolation | no events leak across simulations/users |
| SOC-010 | malformed client payload | validation error ack; connection remains safe |
| SOC-011 | revoked session | disconnect or authorization error on next protected action |
| SOC-012 | outbox restart | committed unsent events delivered after recovery |

## 10. Frontend and accessibility tests

- Form labels, descriptions, and errors are programmatically associated.
- First invalid field receives focus; error summary links to inputs.
- Status badges include text/icons and retain meaning in forced colors.
- Queue rows and printer actions are keyboard operable.
- Job inspector traps focus only while modal on mobile and returns focus on close.
- Live announcements summarize changes without flooding one message per progress tick.
- Reduced-motion preference disables continuous transitions.
- Charts expose equivalent tables/summaries.
- Reconnecting/stale states are visible and mutations disabled during resync.
- Mobile layouts at 360 px do not hide required actions or overflow essential content.

## 11. End-to-end acceptance flows

### E2E-01 Happy path

Start clean simulation → submit three jobs → observe deterministic queue order → two printers acquire jobs → observe progress → complete all jobs → verify terminal history and metrics.

### E2E-02 Algorithm demonstration

Generate seeded mixed workload → clone to benchmark → run FCFS/SJF/Priority Aging → verify workload hash shared → inspect matrix/Gantt → export JSON and validate values.

### E2E-03 Fault and watchdog

Start long job → inject jam → verify paused job/held state → suppress worker progress → advance fake clock across two windows → verify fencing and force release → recover/requeue → complete without duplicate pages.

### E2E-04 Offline and resync

Load dashboard → disconnect client transport → continue server processing → reconnect after replay window → receive snapshot → verify UI equals API state and contains no duplicate events.

## 12. CI gates and artifacts

Pull requests run formatting, lint, strict type checking, unit, integration, component, production build, migration validation, and a short E2E smoke suite. Main/nightly runs full browser matrix, concurrency stress, accessibility scan, dependency vulnerability scan, and soak tests. Failures retain seed, workload, event trace, logs, screenshots, and Playwright traces. Flaky tests are treated as failures to repair, not retried into green without investigation.
