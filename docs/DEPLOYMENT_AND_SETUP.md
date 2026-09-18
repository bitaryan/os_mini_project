# Developer Setup and Deployment Guide

## 1. Prerequisites

- Git 2.40 or newer.
- Node.js active LTS matching `.nvmrc`.
- pnpm version declared by the root `packageManager` field.
- Docker Engine with Compose v2 for containerized database/setup.
- PostgreSQL client tools are optional but useful for diagnosis.

The local single-user demo may use SQLite. Team development and production should use PostgreSQL to match transactional and operational behavior.

## 2. Initial checkout and install

```bash
git clone <repository-url>
cd Mini_Project
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
```

Never commit `.env`, `.env.local`, database files containing user data, or generated secrets. The checked-in examples contain safe names and documented defaults only.

## 3. Environment variables

### 3.1 API service

| Variable | Required | Example | Purpose |
|---|---:|---|---|
| `NODE_ENV` | yes | `development` | runtime mode |
| `PORT` | yes | `4000` | HTTP and Socket.IO listener |
| `DATABASE_URL` | yes | `postgresql://app:app@localhost:5432/printer_queue` | persistence connection |
| `WEB_ORIGIN` | yes | `http://localhost:3000` | exact CORS/Socket origin |
| `SESSION_SECRET` | yes | generated 32+ byte secret | session signing/encryption |
| `LOG_LEVEL` | no | `info` | structured log threshold |
| `QUEUE_CAPACITY` | no | `1000` | bounded active buffer size |
| `DEFAULT_ALGORITHM` | no | `FCFS` | initial scheduler |
| `AGING_INTERVAL_MS` | no | `5000` | priority-aging interval |
| `AGING_FACTOR` | no | `2` | points gained per interval |
| `PRIORITY_CAP` | no | `100` | effective-priority cap |
| `STARVATION_WARNING_MS` | no | `30000` | warning threshold |
| `SIMULATION_TICK_MS` | no | `250` | base worker tick |
| `WATCHDOG_STUCK_MS` | no | `15000` | no-progress window |
| `WORKER_LEASE_MS` | no | `5000` | printer lock lease |
| `ENABLE_FAULT_INJECTION` | no | `true` locally, `false` production | allows jam/stall controls |
| `AUTH_MODE` | no | `local` | identity adapter |
| `TRUST_PROXY` | no | `false` | proxy hop setting; configure exactly |

Generate a local secret with an OS cryptographic utility, for example `openssl rand -base64 48`. Do not reuse example values in deployed environments.

### 3.2 Web application

| Variable | Required | Example | Purpose |
|---|---:|---|---|
| `API_INTERNAL_URL` | yes | `http://localhost:4000` | server-side API access |
| `NEXT_PUBLIC_API_URL` | yes | `http://localhost:4000` | browser REST base |
| `NEXT_PUBLIC_SOCKET_URL` | yes | `http://localhost:4000` | browser Socket.IO origin |
| `NEXT_PUBLIC_APP_ENV` | no | `local` | non-secret environment label |

Only variables prefixed `NEXT_PUBLIC_` reach browser bundles. Never place credentials, database URLs, or session secrets in them.

## 4. Database setup

### PostgreSQL with Docker

```bash
docker compose up -d db
pnpm --filter @printer/api prisma:generate
pnpm --filter @printer/api db:migrate
pnpm --filter @printer/api db:seed
```

The seed creates simulated printer definitions and demo users only; it must not start a live workload automatically. Confirm database readiness with `docker compose ps` before migrations.

### SQLite local mode

Set `DATABASE_URL=file:./data/dev.db`, then run generate, migrate, and seed commands. Keep the file outside web-served directories. SQLite is not the recommended multi-instance production store.

## 5. Run locally

```bash
pnpm dev
```

Expected services:

- Web UI: `http://localhost:3000`
- API/Socket.IO: `http://localhost:4000`
- API health: `http://localhost:4000/health/live`
- API readiness: `http://localhost:4000/health/ready`

Development startup should fail fast on missing required configuration, invalid numeric ranges, unavailable required persistence, or a migration mismatch.

## 6. Verification commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
```

For a manual smoke test: sign in as an operator, submit a three-job workload, confirm Socket status is Live, observe two printer workers, inject and recover a paper jam, wait for completion, and confirm metrics/history match the lifecycle.

## 7. Docker development and production image

### 7.1 Compose services

The root `compose.yaml` should define:

- `db`: pinned PostgreSQL image, named volume, health check;
- `api`: built backend image, depends on healthy database, internal port 4000;
- `web`: built Next.js image, internal port 3000;
- optional `redis`: only when multiple Socket.IO gateway instances are deployed.

Use a private network for database traffic. Publish only web/API ports needed by the host. Put secrets in Compose secrets or the deployment secret manager, not in image layers.

### 7.2 Image requirements

- Multi-stage build with dependency, build, and minimal runtime stages.
- `pnpm install --frozen-lockfile`; no lockfile mutation.
- Non-root runtime user.
- Production dependencies/artifacts only.
- Read-only root filesystem where the platform supports it; writable temporary/data mounts declared explicitly.
- OCI labels include source revision and build time.
- Health checks call liveness/readiness endpoints without authentication secrets.
- Database migrations run as a release job, not concurrently from every replica.

## 8. Production topology

```mermaid
flowchart LR
  U[Browser] --> TLS[Ingress / TLS]
  TLS --> W[Next.js Web]
  TLS --> A[Express + Socket.IO]
  A --> P[(PostgreSQL)]
  A -. optional scale-out .-> R[(Redis adapter)]
  A --> O[Logs / Metrics / Traces]
```

The simplest supported production topology is one web instance, one API/coordinator instance, and managed PostgreSQL. Scale web instances freely. Before scaling API instances, implement simulation ownership so exactly one coordinator writes a given simulation; Redis only fans out Socket events and does not solve domain ownership.

## 9. Deployment sequence

1. Build immutable images from a reviewed commit.
2. Run lint, tests, production builds, image scan, and migration validation.
3. Back up the database and verify restore procedures for schema-changing releases.
4. Deploy configuration and secrets.
5. Run forward migration as a single release job.
6. Deploy API; wait for readiness.
7. Deploy web and route canary traffic.
8. Verify health, login, snapshot fetch, Socket subscription, submit/complete smoke job, and outbox backlog.
9. Increase traffic while watching error rate, command latency, event lag, lock waits, and database latency.

Prefer backward-compatible expand/migrate/contract schema changes. Web and API contracts must tolerate a rolling deployment window.

## 10. Reverse proxy and Socket.IO

The ingress must support HTTP upgrade, preserve forwarding headers, and use timeouts longer than the Socket heartbeat interval. CORS and Socket origins use an explicit allowlist. If long polling remains enabled across multiple gateways, use sticky sessions; WebSocket-only mode may be selected only after confirming target network compatibility.

TLS terminates at the managed ingress or reverse proxy. Cookies use `Secure`, `HttpOnly`, and appropriate `SameSite` attributes in production.

## 11. Health and operations

### Liveness

`GET /health/live` returns success when the process/event loop is alive. It does not query every dependency.

### Readiness

`GET /health/ready` verifies configuration, required database access, migrations, coordinator initialization, and non-fatal invariant state. It returns non-success when the instance should receive no new traffic.

### Alerts

Alert on sustained 5xx rate, readiness failure, database unavailability, outbox backlog age, event delivery lag, repeated forced mutex releases, open watchdog circuit, invariant failure, and queue saturation. Progress-rate changes alone are not an infrastructure incident.

## 12. Backups, retention, and recovery

- Use managed PostgreSQL point-in-time recovery where available.
- Back up before destructive migrations and test restore regularly.
- Retain audit entries according to course/organization policy; default 90 days.
- Prune high-frequency progress events after deriving durable summaries; retain lifecycle events and benchmark metadata longer.
- A backend restart invalidates old worker leases, restores the last snapshot/event tail, and requeues nonterminal work from the last committed page boundary.

## 13. Rollback

Application rollback uses the previous immutable image. Never roll application code back across an incompatible destructive migration. Schema changes therefore follow expand/contract: deploy additive schema, migrate data, deploy readers/writers, and remove old columns only in a later release. If a release corrupts invariant state, pause dispatch, preserve evidence, restore a verified snapshot/backup, then resume.

## 14. Troubleshooting

| Symptom | Checks | Action |
|---|---|---|
| UI shows Offline | browser network, `NEXT_PUBLIC_SOCKET_URL`, origin allowlist, proxy upgrade | correct URL/proxy; reconnect triggers resync |
| API not ready | logs, database health, migration status, invariant alert | restore dependency or run migration |
| Jobs remain queued | printer readiness/capability, permits, scheduler/agent circuit | recover/add compatible printer; inspect alert |
| Duplicate-looking events | event IDs and client reducer logs | ensure deduplication by event ID/version/index |
| Job appears stuck while paused | simulation clock and watchdog metrics | verify watchdog uses simulation, not wall time |
| Forced releases repeat | worker heartbeat, event-loop lag, lease duration | fix worker/load; adjust lease only from evidence |
| Charts lag | progress event rate and client render profile | lower telemetry preference; keep lifecycle stream intact |

## 15. Production safety checklist

- Fault injection disabled unless explicitly required.
- Default development credentials removed.
- Exact CORS origins and trusted proxy hops configured.
- Secrets loaded from a secret manager and rotated.
- TLS, secure cookies, CSRF, authorization, and rate limits verified.
- Database backups and restore drill confirmed.
- Readiness/liveness and alerts connected.
- Queue capacity and benchmark limits configured.
- Logs verified to omit secrets and document contents.
- One authoritative coordinator per simulation guaranteed.
