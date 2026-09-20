# Smart Printer Queue Management System

A browser-based Operating Systems simulation. The approved stack is Next.js, Express, and a TypeScript domain engine. Print jobs contain metadata only; this project does not operate physical printers.

Weeks 1–6 implement the workspace, v1 contracts, deterministic scheduling and metrics, synchronization primitives, the bounded Queue Coordinator and printer workers, transactional SQLite persistence, REST commands, durable Socket.IO delivery, autonomous simulation/recovery, the live control dashboard, event-derived Gantt analytics, isolated algorithm benchmarks, export, and demonstration packaging. See the [implementation status](docs/IMPLEMENTATION_STATUS.md), [Week 6 release guide](docs/WEEK_6_RELEASE.md), [implementation roadmap](docs/IMPLEMENTATION_ROADMAP.md), and [contract coverage](docs/WEEK_1_CONTRACTS.md).

## Local setup

Use the Node version in `.nvmrc` and pnpm version in `package.json`. With nvm and Corepack installed:

```sh
nvm install
nvm use
corepack enable
corepack install
pnpm install --frozen-lockfile
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
openssl rand -base64 48
```

Set `SESSION_SECRET` in `.env` to the generated value, then run:

```sh
pnpm --filter @printer/api db:migrate
pnpm dev
```

Open **http://localhost:3000**. The API listens on **http://localhost:4000**. Root `.env` is loaded by the API; Next.js loads `apps/web/.env.local`. Both processes fail fast on invalid configuration and report field names without secret values. Local environment files are ignored by Git.

The local API authenticates requests with `X-User-Id` (UUID) and `X-User-Role` (`VIEWER`, `OPERATOR`, or `ADMIN`). Mutating resource routes require `Idempotency-Key`; `If-Match: "<stateVersion>"` enables optimistic concurrency checks.

| Endpoint group                       | Week 5 behavior                                           |
| ------------------------------------ | --------------------------------------------------------- |
| `GET /health/live`, `/health/ready`  | Typed liveness and migration/database readiness           |
| `/api/v1/simulations/:id/state`      | Versioned aggregate snapshot with agent health and alerts |
| `/jobs`, `/printers`, `/scheduler`   | Validated command/query routes with role checks           |
| `/printers/:id/faults`, `/actions/*` | Gated jam/stall injection and retained-page recovery      |
| `/metrics`, `/printers/:id/mutex`    | Live metrics and lock inspection                          |
| Socket.IO namespace `/simulations`   | Authenticated rooms, replay/resync, and durable events    |

The dashboard seeds from the committed REST snapshot and only reports a live connection after its Socket.IO room subscription is acknowledged. Operators can submit jobs and deterministic bursts, pause/resume, change speed, cancel work, inject/recover jams, and inspect queue, printer, mutex, metric, agent, alert, and event state. Viewer mode removes mutation controls.

## Verification

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` runs formatting, lint, types, unit/HTTP tests, and production builds. `pnpm test:integration` includes HTTP plus Week 5 automation, recovery, and real Socket.IO coverage. Browser tests require a completed build, start isolated API/web processes on ports 4100/3100 with a fresh database, and verify desktop and 360 px mobile layouts, keyboard access, live submission, paper jam, recovery, completion, events, and viewer restrictions. Screenshots and failed traces are written to ignored `test-results/`. CI runs these checks plus a production dependency audit on every push and pull request.

Run the deterministic Week 3 two-printer demonstration with:

```sh
pnpm --filter @printer/api demo
```

It submits four jobs, cancels one, processes the remaining jobs concurrently at page boundaries, prints lifecycle/audit events, and exits only after verifying terminal counts, throughput, permits, and lock release.

HTTP/browser tests require permission to open local ports. Builds use system font fallbacks from the design specification and do not download fonts. ESLint 9 is pinned for compatibility with Next.js's current React/accessibility lint plugins; upgrade together when their peer ranges support ESLint 10.

## Production-build smoke

After `pnpm build`, run these in separate terminals with the same local environment files:

```sh
pnpm --filter @printer/api start
pnpm --filter @printer/web start
```

This is a packaged Week 6 local demonstration release, not an internet-ready production service. Local header authentication and SQLite are intentionally retained; public deployment needs real session authentication and provider-specific PostgreSQL migrations.

## Repository

- `apps/web`: App Router live dashboard, Socket client, role-aware controls, and responsive operations UI.
- `apps/api`: Express/Socket.IO API, Prisma persistence/outbox, autonomous agents, deterministic scheduler, synchronization primitives, Queue Coordinator, and printer workers.
- `packages/contracts`: framework-independent Zod schemas and inferred types.
- `packages/config`: shared strict TypeScript and lint configuration.
- `packages/test-fixtures`: hand-calculated reference workloads and metric checks.
- `docs`: approved specifications, contract coverage, and milestone evidence.

Feature folders, UI primitives, and dependencies for later phases are added when their behavior is implemented. The browser never imports the scheduling engine.
