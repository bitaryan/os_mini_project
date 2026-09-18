# Product Requirements Document

## 1. Product summary

### 1.1 Product name

Smart Printer Queue Management System (OS Simulation)

### 1.2 Problem statement

Operating-system scheduling and synchronization are difficult to understand from static diagrams. Learners need a controllable environment in which concurrent jobs compete for finite printer resources, scheduling policies produce visibly different outcomes, locks protect critical sections, faults threaten liveness, and a watchdog performs safe recovery.

The product is a full-stack educational simulation. It does not send documents to physical printers. It combines a live operations dashboard with reproducible workloads and algorithm benchmarks.

### 1.3 Product objectives

- Make FCFS, SJF, Priority Scheduling, and Dynamic Aging observable and comparable.
- Demonstrate producer-consumer coordination with a bounded shared queue.
- Demonstrate per-resource mutexes, a counting semaphore, lock ownership, and deadlock prevention.
- Provide real-time job/printer/agent state through Socket.IO.
- Let users safely inject failures and observe watchdog recovery.
- Produce deterministic, exportable benchmark data suitable for classroom explanation.

### 1.4 Success measures

| Measure | Target |
|---|---|
| First successful job submission | within 2 minutes for a new user |
| State convergence | UI reflects committed lifecycle events within 500 ms p95 on a local network |
| Scheduling correctness | 100% pass rate for reference workload tests |
| Mutual exclusion | zero overlapping active jobs per printer in stress tests |
| Recovery | stuck job detected and intercepted within configured threshold plus one tick |
| Reproducibility | identical seed/configuration produces identical benchmark result |
| Accessibility | WCAG 2.2 AA for core workflows |

## 2. Users and roles

### 2.1 Student / Viewer

Wants to observe queue state, inspect why a job was selected, view charts, and compare algorithms. Can submit ordinary jobs in an open classroom configuration but cannot inject faults or modify global configuration unless promoted.

### 2.2 Instructor / Operator

Creates workloads, switches algorithms, adjusts aging, changes simulation speed, injects faults, recovers printers, and runs demonstrations. Can inspect audit and lock state.

### 2.3 Administrator

Manages environment configuration, users/roles, queue capacity, printer definitions, retention, and deployment health. Has all operator rights.

### 2.4 Automation Agent

Acts using narrowly scoped service permissions. Agents can observe events and issue versioned commands but cannot bypass the Queue Coordinator.

## 3. Scope

### 3.1 In scope for the core release

- Next.js responsive web interface with Dashboard, Submission, Analytics, and Benchmark pages.
- Express REST API and Socket.IO real-time protocol.
- Metadata-only print jobs and configurable simulated printers.
- FCFS, non-preemptive SJF, and non-preemptive Priority with Dynamic Aging.
- Bounded queue, queue mutex, per-printer mutexes, and available-printer semaphore.
- Deterministic simulation clock with pause and speed controls.
- Paper-jam injection, printer recovery, stuck-job detection, fencing, and bounded retries.
- Rolling metrics, Gantt view, queue depth, mutex timeline, and benchmark matrix.
- Audit history, snapshots, idempotent mutations, authentication, and role checks.
- Local Docker development and production deployment guidance.

### 3.2 Explicitly out of scope

- Physical printer drivers, IPP, USB, spool files, or document rendering.
- Uploading, storing, previewing, or scanning document contents.
- Preemptive page-level CPU algorithms such as Round Robin in the core release.
- Multi-region active-active writers for one simulation.
- Billing, quotas by money, mobile-native applications, or push notifications.
- Generative-AI decisions in the critical scheduling path.

## 4. User stories and acceptance criteria

### US-01: Submit a print job

As a user, I want to submit job metadata so that I can observe it progress through the simulated queue.

Acceptance criteria:

- Required fields are validated consistently in browser and API.
- A valid request returns `202` with a stable ID, sequence, and status.
- Duplicate requests using the same idempotency key produce one job.
- A full queue returns a specific capacity error without changing state.
- The job appears through `job.created` and can be correlated to the request.

### US-02: Observe the live queue

As a student, I want queue rank and scheduler reasoning so that I can understand selection.

Acceptance criteria:

- Each ready job shows rank, pages remaining, wait, base priority, effective priority, and state.
- Rank changes update without a full-page refresh.
- Selecting a job explains the comparator and tie-break result.
- Reconnection restores a consistent snapshot before applying new events.

### US-03: Run multiple printers concurrently

As an operator, I want several simulated printers so that concurrency is visible.

Acceptance criteria:

- Each ready compatible printer may process one job independently.
- No printer processes two jobs at the same time.
- No job is assigned to two printers.
- Utilization and Gantt lanes distinguish concurrent intervals.

### US-04: Change scheduling algorithm

As an instructor, I want to switch algorithms so that I can demonstrate their trade-offs.

Acceptance criteria:

- Supported values are FCFS, SJF, and Priority with Dynamic Aging.
- Running jobs are not preempted.
- Ready jobs are reordered atomically when requested.
- The update carries a configuration revision and audit record.

### US-05: Prevent priority starvation

As a student, I want to observe aging so that low-priority jobs eventually gain scheduling preference.

Acceptance criteria:

- Effective priority follows the documented formula and cap.
- Aging is derived from wait time and survives missed ticks/restarts.
- Base priority remains unchanged.
- Jobs exceeding the warning threshold are visibly marked.

### US-06: Inject and recover a paper jam

As an operator, I want to jam a printer so that I can examine interruption and recovery.

Acceptance criteria:

- Fault injection requires operator permission and explicit confirmation.
- Immediate mode pauses before the next page; page-boundary mode finishes the current page.
- Lock, printer, and job states stay consistent.
- Manual or scheduled recovery resumes or requeues according to policy.

### US-07: Watchdog recovery

As an operator, I want the system to detect a stalled worker and recover without double printing.

Acceptance criteria:

- Detection ignores intentionally paused simulation time.
- Two missed progress windows are required.
- The stale worker is fenced before forced mutex release.
- A late stale progress message is rejected.
- Retry exhaustion fails the job and raises an actionable alert.

### US-08: Generate a burst

As an instructor, I want seeded workload generation so that demonstrations are repeatable.

Acceptance criteria:

- Identical generator settings and seed yield identical jobs.
- Preview does not mutate live state.
- Atomic and explicit partial-capacity modes behave as documented.
- Accepted and rejected counts and reasons are returned.

### US-09: Compare algorithms

As a student, I want one workload evaluated under several algorithms so that I can compare outcomes fairly.

Acceptance criteria:

- Benchmark runs use an immutable workload clone and do not affect live state.
- Metrics include wait, turnaround, makespan, throughput, utilization, fairness, and starvation.
- Results carry engine version, seed, configuration, and workload hash.
- JSON and CSV export preserve exact numeric values.

### US-10: Audit system actions

As an administrator, I want a trace of manual and automated actions so that failures are explainable.

Acceptance criteria:

- Each mutation records actor, command, correlation ID, outcome, and before/after state versions.
- Sensitive credentials and document content are absent.
- Audit records are append-only and queryable by time, actor, type, and correlation ID.

## 5. Functional requirements

### FR-1 Job management

- Create single jobs and seeded bursts.
- List/filter/sort active and historical jobs.
- Read one job with lifecycle and timing details.
- Edit base priority only while queued/ready and with sufficient permission.
- Cancel queued jobs immediately; stop printing jobs after the current page.
- Preserve immutable ID, sequence, owner, and submission timestamp.

### FR-2 Printer management

- List printer capability and state.
- Create/update simulated printers under administrator control.
- Mark printers offline only after handling active work by chosen policy.
- Expose progress, speed, active job, mutex owner, and lease age.
- Support paper jam and recovery in simulation environments.

### FR-3 Scheduling

- Implement stable FCFS, stable SJF, and stable Priority with Dynamic Aging.
- Use deterministic tie-breakers.
- Filter jobs by printer compatibility before assignment.
- Do not preempt running jobs on algorithm/config changes.
- Expose human-readable selection explanations.

### FR-4 Synchronization

- Serialize queue mutations using a fair mutex.
- Enforce one binary mutex per printer.
- Model available capacity with a counting semaphore.
- Enforce lock acquisition order and bounded acquisition time.
- Fence stale workers before forced release.

### FR-5 Simulation control

- Start, pause, resume, reset, and adjust speed.
- Use a monotonic simulation clock.
- Freeze progress and watchdog duration while paused.
- Reset only with administrator confirmation; preserve audit and optionally history.

### FR-6 Real-time updates

- Deliver lifecycle, progress, printer, queue, lock, metric, agent, and alert events.
- Version state-changing events and deduplicate by event ID.
- Provide full snapshot resynchronization after event gaps.
- Coalesce progress under backpressure without dropping terminal events.

### FR-7 Analytics

- Compute per-job wait, response, service, and turnaround times.
- Compute throughput, utilization, queue depth, percentile waits, fairness, and starvation count.
- Display synchronized Gantt, queue-depth, distribution, and lock timelines.
- Provide table alternatives for chart content.

### FR-8 Agents

- Run automation, watchdog, load balancing, starvation guard, and metrics evaluator.
- Expose agent health and circuit state.
- Enforce command scopes and version checks.
- Record every accepted and rejected agent command.

## 6. Non-functional requirements

### Performance

- Support 1,000 active jobs, 64 printers, and 20 connected dashboard clients per simulation.
- Accept a 1,000-job burst within 2 seconds p95 in local reference hardware.
- Schedule one dispatch in under 50 ms p95 at maximum core workload.
- Keep browser interaction responsive with Socket progress at up to 10 Hz.

### Reliability and consistency

- No committed mutation without persistence when persistence is configured as required.
- Recover active state from snapshot plus event tail after restart.
- Idempotent POST/mutation commands retained for at least 24 hours.
- Terminal job state and page count never regress.

### Security

- Validate all trust-boundary payloads.
- Authenticate REST and Socket connections; enforce viewer/operator/admin authorization.
- Apply CSRF protection to cookie-authenticated mutations and rate limits per actor/IP.
- Do not accept document files or executable data.
- Redact secrets and minimize personally identifiable data in logs.

### Accessibility and usability

- Meet WCAG 2.2 AA for core workflows.
- Support keyboard-only operation and reduced motion.
- Never use color as the sole status indicator.
- Provide accessible chart summaries and live-region announcements.

### Maintainability and observability

- Strict TypeScript; shared schemas generate inferred types.
- Pure scheduler functions have reference fixtures and property tests.
- Structured logs include correlation and simulation IDs.
- Metrics cover command latency, queue depth, connected clients, lock wait, agent circuit state, and event lag.

## 7. Business and domain rules

1. Larger numeric priority means more urgent.
2. Default priority is 50; valid range is 0–100.
3. Jobs are metadata-only and pages are simulated units of work.
4. A worker commits progress at page boundaries.
5. Cancellation of active work takes effect after the current page.
6. Scheduler changes are non-preemptive.
7. Ties resolve by submission time then immutable sequence.
8. A job blocked by printer capability remains active and resumes eligibility when capacity appears.
9. Auto-recovery preserves completed pages.
10. Three stalls (initial plus two retries) produce terminal failure.

## 8. Edge cases

| Scenario | Required behavior |
|---|---|
| Simultaneous equal jobs | stable sequence determines order |
| Clock goes backward | monotonic simulation clock ignores wall-clock regression |
| Zero compatible printers | job becomes `BLOCKED`, not failed |
| Printer goes offline while idle | remove one semaphore permit |
| Printer goes offline while printing | finish/requeue policy executes atomically; no new dispatch |
| Cancel and complete race | first committed terminal transition wins; second returns conflict |
| Jam on final page | committed page completion wins if earlier; otherwise pause then recover |
| Duplicate Socket event | client ignores known event ID |
| Event version gap | stop mutation reduction and fetch full snapshot |
| Duplicate POST after timeout | same idempotency key returns same job/result |
| Aging reaches cap | tie-break by arrival/sequence; never exceed cap |
| Queue fills during burst preview | enqueue performs fresh capacity check |
| Backend restarts mid-page | only committed pages retained; incomplete page repeats |
| Stale worker reports progress | fencing-token mismatch rejects it |
| Database write fails | mutation is rejected and in-memory state is not advanced |
| Metrics has no samples | return `null` for unavailable values, not misleading zero |
| Simulation paused longer than threshold | watchdog does not classify jobs as stuck |
| Last client disconnects | simulation continues unless environment policy says auto-pause |

## 9. Release acceptance

The core release is acceptable when all required pages and endpoints are implemented; reference scheduler, mutex, concurrency, fault, reconnect, and authorization tests pass; one end-to-end scenario submits a burst, processes concurrent jobs, injects a jam, performs recovery, completes jobs, and shows matching metrics; production build and Docker health checks pass; and the API/event documentation matches executable schemas.
