# Technical Stack and Repository Structure

## 1. Stack decisions

The solution is a TypeScript monorepo with a Next.js frontend and a Node.js/Express backend. The scheduling engine is a pure TypeScript domain package inside the backend process. This matches the requested architecture and avoids distributed locking for a classroom simulation while preserving explicit OS synchronization semantics.

| Layer | Technology | Responsibility |
|---|---|---|
| Web | Next.js, TypeScript, App Router | routing, SSR shell, client dashboard |
| Styling | Tailwind CSS, Shadcn UI, Radix primitives | tokens, accessible UI components |
| Charts | Recharts | Gantt adapters, time series, distributions |
| Forms | React Hook Form + Zod resolver | typed validation and error focus |
| Server state | TanStack Query | REST cache, mutations, invalidation |
| Live state | Socket.IO client + reducer | ordered real-time event application |
| API | Node.js, Express, TypeScript | HTTP boundary, auth, queries, commands |
| Real time | Socket.IO | rooms, reconnect, versioned events |
| Validation | Zod | shared request, response, and event schemas |
| Persistence | Prisma with PostgreSQL; SQLite for local demo | snapshots, jobs, audit, outbox, benchmarks |
| Logging | Pino | structured application and audit-support logs |
| Tests | Vitest, Supertest, Testing Library, Playwright | unit, integration, component, E2E |
| Tooling | pnpm workspaces, ESLint, Prettier, TypeScript | repeatable builds and quality gates |
| Deployment | Docker, Compose, reverse proxy/platform ingress | local and production packaging |

## 2. Runtime versions

- Node.js: current active LTS, pinned in `.nvmrc` and container image.
- pnpm: pinned with the root `packageManager` field.
- TypeScript: one workspace version with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Browser baseline: current and previous major Chrome, Firefox, Safari, and Edge.
- PostgreSQL: supported current major selected by deployment; local Compose pins an exact image tag.

Exact package versions belong in the lockfile, not duplicated in documentation. Dependency updates use reviewed, reproducible lockfile changes.

## 3. Monorepo layout

```text
.
├── AGENTS.MD
├── ARCHITECTURE.MD
├── DESIGN.MD
├── SKILLS.MD
├── apps/
│   ├── web/
│   │   ├── app/
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── jobs/new/page.tsx
│   │   │   ├── analytics/page.tsx
│   │   │   ├── benchmarks/page.tsx
│   │   │   └── layout.tsx
│   │   ├── components/
│   │   │   ├── ui/
│   │   │   └── domain/
│   │   ├── lib/api/
│   │   ├── lib/socket/
│   │   ├── lib/charts/
│   │   └── tests/
│   └── api/
│       ├── src/
│       │   ├── http/
│       │   ├── socket/
│       │   ├── domain/
│       │   │   ├── scheduling/
│       │   │   ├── synchronization/
│       │   │   ├── workers/
│       │   │   └── agents/
│       │   ├── persistence/
│       │   ├── observability/
│       │   └── server.ts
│       ├── prisma/
│       └── tests/
├── packages/
│   ├── contracts/       # Zod schemas, inferred types, error codes
│   ├── config/          # shared lint/tsconfig presets
│   └── test-fixtures/   # deterministic workloads only
├── docs/
├── docker/
├── compose.yaml
├── pnpm-workspace.yaml
└── package.json
```

The scheduler and synchronization code remains in `apps/api/src/domain`; it is not imported by the browser. `packages/contracts` contains data contracts only and has no runtime dependency on Express, React, Prisma, or Socket.IO.

## 4. Frontend architecture

### 4.1 App Router boundaries

Server Components render layouts, authorization-aware navigation, and initial non-live shells. Client Components are limited to live subscriptions, forms, interactive tables, dialogs, and Recharts. Browser-only libraries are dynamically imported where required.

The web app never connects directly to persistence. Initial state is fetched from the Express API, then live state is advanced through Socket.IO.

### 4.2 State management

Use three deliberately separate state categories:

1. **Server query state:** TanStack Query stores REST snapshots, job history pages, benchmark results, and mutation status.
2. **Live simulation state:** a scoped reducer applies versioned Socket events to `{ jobs, printers, scheduler, metrics, agents, stateVersion }`.
3. **Local UI state:** component state or URL search parameters store selection, filters, open panels, and chart range.

Do not copy query results into a general global store. On initial load, the snapshot seeds the live reducer. A newer complete snapshot atomically replaces it. Optimistic job rows are keyed by correlation ID and reconciled on `job.created`.

### 4.3 Styling and components

Tailwind consumes the semantic CSS tokens in `DESIGN.MD`. Shadcn components are copied into `components/ui` and modified only for shared accessibility or token needs. Domain components compose primitives and contain product behavior. Class merging uses the Shadcn-provided helper; no second styling system is introduced.

### 4.4 Recharts

Recharts receives normalized chart view models, not raw domain objects. Time axes use simulation milliseconds. Large Gantt sets window by visible range and printer lanes. Every visualization has a table/summary fallback and deterministic colors keyed by job ID.

## 5. Backend architecture

### 5.1 Express boundary

Middleware order:

1. request ID/correlation ID;
2. trusted proxy and security headers;
3. body size limit and JSON parser;
4. authentication/session resolution;
5. rate limiting;
6. route-specific Zod validation;
7. authorization;
8. controller and command/query dispatch;
9. typed error translation;
10. structured access logging.

Controllers translate HTTP to commands or queries. They do not implement scheduling or mutate repository objects.

### 5.2 Domain core

- Scheduler functions are pure and return selected IDs plus explanations.
- Queue Coordinator owns atomic transitions, versions, and invariants.
- Worker Coordinator owns async printer loops and page-boundary commits.
- Simulation Clock owns monotonic time, pause, and speed.
- Agents subscribe to committed internal events and issue commands back through the coordinator.
- Event Outbox stores events transactionally and forwards them to Socket.IO.

### 5.3 Persistence

Prisma maps durable records; domain code depends on repository interfaces implemented by the persistence adapter. SQLite is acceptable for a single local simulation in WAL mode. PostgreSQL is required for deployed multi-user service, stronger concurrency, and operational backups.

Recommended indexes:

- jobs: `(simulation_id, status, submitted_at)`, `(simulation_id, sequence)`, `(owner_id, submitted_at)`;
- domain events: unique `(simulation_id, state_version, event_index)` and `(event_id)`;
- audit: `(simulation_id, occurred_at)`, `(correlation_id)`, `(actor_id, occurred_at)`;
- idempotency: unique `(actor_id, route_key, idempotency_key)` with expiry;
- benchmarks: `(simulation_id, created_at)` and workload hash.

## 6. Shared contracts

Zod schemas are the executable source for REST and Socket payload types:

```ts
import { z } from "zod";

export const submitJobSchema = z.object({
  documentName: z.string().trim().min(1).max(120),
  pages: z.number().int().min(1).max(10_000),
  basePriority: z.number().int().min(0).max(100).default(50),
  colorMode: z.enum(["MONO", "COLOR"]),
  duplex: z.boolean(),
  arrivalDelayMs: z.number().int().min(0).max(3_600_000).default(0),
}).strict();

export type SubmitJobInput = z.infer<typeof submitJobSchema>;
```

Schemas use `.strict()` at external boundaries. Response types are inferred, tested, and optionally transformed into OpenAPI; handwritten duplicate interfaces are avoided.

## 7. Real-time protocol implementation

### 7.1 Connection lifecycle

- Authenticate the handshake with the same user identity model as REST.
- Authorize simulation room subscription.
- Client sends `lastSeenStateVersion`.
- Server replays a bounded retained event range when possible; otherwise sends `system.resync.required`.
- Heartbeats use Socket.IO transport ping; application ping measures UI-visible latency only.

### 7.2 Ordering and delivery

State-changing events have monotonically increasing state versions. A transaction may emit several ordered events at one version using `eventIndex`. Client identity is `(stateVersion, eventIndex, eventId)`. Delivery is at least once; reducers are idempotent.

Lifecycle and alert events enter the durable outbox. High-frequency progress frames may be coalesced after progress is durably committed. Server-side room emission never happens while holding a domain mutex.

### 7.3 Horizontal delivery

The core release runs one API instance. When multiple Socket gateways are required, use the official Socket.IO Redis adapter and sticky transport/session configuration. The simulation coordinator remains a single writer per simulation; Redis Pub/Sub distributes events but is not the source of truth.

## 8. Synchronization implementation

Minimal promise-based primitives implement the simulation:

- `FairMutex`: FIFO waiters, acquisition timeout, owner token, `runExclusive`.
- `BinaryLeaseMutex`: per-printer lease, expiry, renew, fence token.
- `CountingSemaphore`: bounded permits for ready printers.
- `BoundedBuffer`: capacity checks and immutable snapshot reads.

Each primitive exposes inspection data for analytics but mutation methods remain private to coordinators. Lock order is encoded in service boundaries and tested. Production code uses `try/finally` for every acquisition.

## 9. Security dependencies and practices

- `helmet` for HTTP security headers.
- platform/session library selected for deployment identity; secure, HTTP-only, SameSite cookies when using browser sessions.
- CSRF tokens for cookie-authenticated mutations.
- `cors` allowlist; no wildcard credentials.
- `express-rate-limit` or platform gateway limits for command classes.
- Zod request and event validation.
- Password storage, if local accounts are enabled, uses Argon2id through a maintained library.

Secrets come from environment/secret manager and never use `NEXT_PUBLIC_` unless safe for any browser user. The web app exposes only the API base URL and public Socket path.

## 10. Testing and quality tooling

- Vitest runs pure scheduler, clock, reducer, mutex, agent, and contract tests.
- Fast-check may be used for scheduler invariants and generated concurrency sequences if adopted; fixed reference fixtures remain mandatory.
- Supertest exercises Express validation, authorization, idempotency, and response mapping.
- Socket.IO integration tests use real in-memory HTTP servers and clients.
- Testing Library covers accessible component behavior.
- Playwright covers dashboard, submission, disconnect/resync, jam/recovery, and benchmark journeys.
- ESLint catches unsafe promises and React issues; `tsc --noEmit` enforces strict contracts.

## 11. Observability

Pino logs one JSON object per record with timestamp, level, service, environment, simulation ID, request/event/command/correlation IDs, actor ID, duration, and result. Metrics use OpenTelemetry-compatible instruments where deployment supports them.

Required measures:

- HTTP latency/error count by route and status;
- active Socket connections, reconnects, and event lag;
- queue depth/capacity, dispatch latency, and throughput;
- mutex wait/hold time, lease expiry, and forced release count;
- worker heartbeat delay and agent circuit state;
- snapshot duration, outbox backlog, and database latency.

Health endpoints separate liveness from readiness. Readiness fails when required persistence is unavailable or invariants have paused dispatch.

## 12. Dependency policy

Use platform features and existing stack libraries first. Add dependencies only for maintained, security-sensitive, or otherwise non-trivial capabilities. Keep the scheduler and synchronization primitives dependency-light. Commit the lockfile, review install scripts, run vulnerability scanning in CI, and remove packages no longer imported.
