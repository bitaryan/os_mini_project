# Week 1 contract coverage

`packages/contracts` is the v1 executable source. Request objects reject unknown keys; response objects validate known fields and discard additive fields. Types are inferred from schemas. `API_AND_EVENTS.md` takes precedence over abbreviated examples in the architecture and design documents (including simulation-scoped routes and event indexes).

Implemented schemas do not implement endpoints, authorization, scheduling, persistence, or event delivery. Those remain in the roadmap's assigned weeks.

| API/event surface                                                                  | Week 1 schema or explicitly scheduled task                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Common IDs, timestamps, enums, roles, errors                                       | `primitives.ts`                                                                                                            |
| API metadata, success/error envelopes, cursor pages                                | `http.ts`                                                                                                                  |
| Jobs, printers, mutex state, scheduler, simulation, metrics, agents, alerts, audit | `resources.ts`                                                                                                             |
| State snapshot                                                                     | `stateSnapshotSchema`                                                                                                      |
| Pause, resume, simulation update/reset requests                                    | `requests.ts`; reset operation response finalized Week 4                                                                   |
| Create/update job, generated burst requests; burst response                        | `requests.ts`, `burstResultSchema`                                                                                         |
| Job list query, detail timeline/timing, cancellation headers                       | Week 4: freeze query decoding, detail schema and header validation before routes                                           |
| Printer creation                                                                   | `createPrinterRequestSchema`; resource response                                                                            |
| Printer list/detail/update and mutex inspection                                    | Week 4: define update fields, recent utilization/interval payload and redaction shapes before routes; base resources exist |
| Fault injection and recovery requests                                              | `injectPrinterFaultRequestSchema`, `recoverPrinterRequestSchema`; combined result payloads Week 6 before routes            |
| Scheduler read/update/rebalance                                                    | Config and request schemas exist; comparator, ordered IDs and placement response wrappers Week 4                           |
| Metrics query                                                                      | Resource exists; bounded HTTP query decoder Week 4                                                                         |
| Analytics timeline                                                                 | Week 9: freeze queries, intervals, queue-depth points and paginated responses before UI                                    |
| Benchmark request/acceptance                                                       | `benchmarkRequestSchema`, `benchmarkAcceptedSchema`                                                                        |
| Benchmark pending/result/export                                                    | Week 10: freeze exact normalized config, metric matrix, Gantt, JSON/CSV response schemas before runner/UI                  |
| Audit list                                                                         | `auditEntrySchema`; filters/pagination decoder Week 4                                                                      |
| Health endpoints                                                                   | `healthLiveSchema`, `healthReadySchema`                                                                                    |
| All 25 documented server event variants                                            | `serverEventSchema` discriminates payloads by event type                                                                   |
| All 7 client event payloads                                                        | `clientEventPayloadSchemas` (strict nested request objects)                                                                |
| Socket acknowledgements                                                            | `socketAckSchema`, `subscribeAckSchema`, `pingAckSchema`; departure/control/effective-rate result schemas Week 5           |
| Socket authentication handshake                                                    | Week 5: deployment identity/session adapter schema before connection handling                                              |
| Agent command envelope and all 7 commands in AGENTS.MD                             | `agentCommandSchema`, `agentCommandResultSchema`; permission/lease/state enforcement Weeks 3–6                             |
| Internal event and tool context envelopes                                          | `agentEventSchema`, `toolContextSchema`; concrete internal skill results/events Weeks 3–6                                  |

Conventions frozen for implementation:

- `pagesPerMinute` may be fractional within 1–600; page counts and simulation timestamps are integers. Aggregate averages may be fractional and are `null` without samples. Utilization is a fraction from 0 to 1.
- Burst distribution bounds are integers; bounded-normal mean may be fractional within those bounds and standard deviation must be positive. Name prefixes are limited to 100 characters to leave room for generated suffixes. Arrival intervals are bounded to 3,600,000 ms; generated cumulative arrival limits must be checked in Week 7.
- Benchmark jobs/algorithms must be unique. Workloads are limited to 10,000 jobs; burst requests to 1,000.
- Resource validation checks page accounting and capacity. Cross-resource ownership, lifecycle transitions and monotonicity belong to the coordinator and its Week 3 invariant tests.
- UTC resource timestamps are transport values. Scheduling uses integer simulation milliseconds in the domain, never wall-clock timestamp subtraction.
- Unknown future server event types must be ignored by the Week 5 dispatcher before parsing known events. A known event with an invalid payload is an error.
- Health responses are unwrapped, matching the documented liveness endpoint. Readiness is `503 not_ready` until every required component is ready. Week 1 reports database, migrations, coordinator and invariant checks as `not_implemented`; it never claims the simulator is ready.
- Explicit-job burst input is mentioned but has no request shape in the specification. Its schema is scheduled for Week 4; Week 1 freezes the documented generated-burst shape only.

Contract tests check the specification's error example and complete server event/error catalogs to catch drift.
