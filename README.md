# Smart Printer Queue Management System

A browser-based Operating Systems simulation. The approved stack is Next.js, Express, and a TypeScript domain engine. Print jobs contain metadata only; this project does not operate physical printers.

Weeks 1–2 implement the workspace, v1 contracts, deterministic reference workloads, environment validation, health endpoints, minimal web shell, CI, lifecycle rules, the simulation clock, FCFS, SJF, Priority with Dynamic Aging, scheduler explanations, and pure timing metrics. Synchronization begins in Week 3. See the [implementation roadmap](docs/IMPLEMENTATION_ROADMAP.md) and [contract coverage](docs/WEEK_1_CONTRACTS.md).

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
pnpm dev
```

Open **http://localhost:3000**. The API listens on **http://localhost:4000**. Root `.env` is loaded by the API; Next.js loads `apps/web/.env.local`. Both processes fail fast on invalid configuration and report field names without secret values. Local environment files are ignored by Git.

The local authentication setting and database URL are validated configuration for future phases. Authentication, database access, migrations, job commands, synchronization, workers, and Socket.IO delivery are not implemented yet. No database setup is required.

| Endpoint            | Week 1 behavior                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health/live`  | `200`, typed process liveness                                                                  |
| `GET /health/ready` | `503`, configuration and scheduler ready; persistence/coordinator components `not_implemented` |
| `/dashboard`        | Real API connectivity, component readiness, environment label                                  |
| Other API routes    | Typed `404 NOT_FOUND`                                                                          |

The shell distinguishes a reachable API with incomplete services from a disconnected or invalid API response. **Check again** reloads readiness; live subscriptions arrive in Week 5.

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

`pnpm check` runs formatting, lint, types, unit/HTTP tests, and production builds. `pnpm test:integration` runs just the HTTP tests. Browser tests require a completed build, start isolated API/web processes on ports 4100/3100, and verify desktop and 360 px mobile layouts, keyboard access, real health connectivity, and refresh. Screenshots and failed traces are written to ignored `test-results/`. CI runs these checks plus a production dependency audit on every push and pull request.

HTTP/browser tests require permission to open local ports. Builds use system font fallbacks from the design specification and do not download fonts. ESLint 9 is pinned for compatibility with Next.js's current React/accessibility lint plugins; upgrade together when their peer ranges support ESLint 10.

## Production-build smoke

After `pnpm build`, run these in separate terminals with the same local environment files:

```sh
pnpm --filter @printer/api start
pnpm --filter @printer/web start
```

This is a foundation and pure-domain smoke check, not a production simulation release. Docker, persistence, identity integration, synchronization, and complete lifecycle demonstrations stay in their assigned roadmap phases. The original [deployment guide](docs/DEPLOYMENT_AND_SETUP.md) describes that later target; commands for migrations and seed data are not available yet.

## Repository

- `apps/web`: App Router shell and validated API health reader.
- `apps/api`: Express health service, validated environment, and pure deterministic domain engine.
- `packages/contracts`: framework-independent Zod schemas and inferred types.
- `packages/config`: shared strict TypeScript and lint configuration.
- `packages/test-fixtures`: hand-calculated reference workloads and metric checks.
- `docs`: approved specifications, contract coverage, and milestone evidence.

Feature folders, UI primitives, and dependencies for later phases are added when their behavior is implemented. The browser never imports the scheduling engine.
