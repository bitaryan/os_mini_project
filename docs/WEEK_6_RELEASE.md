# Week 6 demonstration release

## Included

- Event-derived printer Gantt timeline with execution, idle, jam, offline, and mutex intervals plus an accessible table.
- Isolated FCFS, SJF, and Priority Aging benchmark runs over immutable current or explicit workloads.
- SHA-256 workload identity, persisted benchmark results, exact JSON export, and numeric CSV export.
- Existing security headers, exact-origin CORS, payload limits, API rate limits, role checks, keyboard focus styles, responsive layouts, and reduced-motion behavior.
- Reproducible API/Web container targets with a persistent SQLite volume and readiness-gated startup.
- Recoverable SQLite backup/restore commands with an integrity-check drill.

## Local release rehearsal

```sh
export SESSION_SECRET="$(openssl rand -base64 48)"
docker compose up --build
```

For traceable image metadata, set `VERSION` and `REVISION` before building. The values are written to OCI image labels.

```sh
export VERSION=0.1.0
export REVISION="$(git rev-parse HEAD)"
docker compose build
```

Open `http://localhost:3000`, enqueue the seed-42 burst, observe completion, run **Compare current queue** before the queue drains, and export JSON and CSV. Inject and recover a jam while a job is active to verify the Gantt interruption.

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

Stop the API before restore. A successful restore retains the replaced database beside it with a timestamped `.pre-restore-*` suffix for rollback.

```sh
pnpm --filter @printer/api db:backup -- ./data/dev.db ./backups/dev.db
pnpm --filter @printer/api db:restore -- ./backups/dev.db ./data/dev.db --confirm
```

The packaged release remains a local demonstration: `AUTH_MODE=local` trusts explicit identity headers and SQLite is single-instance storage. Internet deployment requires real session authentication and a provider-specific PostgreSQL migration before exposing it publicly.

See [Implementation status](IMPLEMENTATION_STATUS.md) for the audited release matrix and environment-dependent production steps.
