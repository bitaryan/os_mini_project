import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  benchmarkRequestSchema,
  createBurstRequestSchema,
  createJobRequestSchema,
  createPrinterRequestSchema,
  injectPrinterFaultRequestSchema,
  jobStatusSchema,
  pauseSimulationRequestSchema,
  rebalanceRequestSchema,
  recoverPrinterRequestSchema,
  resumeSimulationRequestSchema,
  roleSchema,
  resetSimulationRequestSchema,
  timestampSchema,
  updateJobRequestSchema,
  updatePrinterRequestSchema,
  updateSchedulerRequestSchema,
  updateSimulationRequestSchema,
  uuidSchema,
} from '@printer/contracts';
import type { StateSnapshot } from '@printer/contracts';
import {
  buildTimeline,
  generateBurst,
  runBenchmark,
  type MutationContext,
  type Role,
  type SimulationService,
} from '../application/index.js';
import { rankJobs, type PrinterState } from '../domain/index.js';
import { HttpError } from './http-error.js';
import { jobResources, metricsResource, stateResource } from './resources.js';

const simulationParams = z.object({ simulationId: uuidSchema });
const jobParams = simulationParams.extend({ jobId: uuidSchema });
const printerParams = simulationParams.extend({ printerId: uuidSchema });
const benchmarkParams = simulationParams.extend({ benchmarkId: uuidSchema });
const timelineQuery = z
  .object({
    fromMs: z.coerce.number().int().nonnegative().default(0),
    toMs: z.coerce.number().int().nonnegative().optional(),
    printerId: uuidSchema.optional(),
    jobId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(20_000).default(20_000),
  })
  .refine((value) => value.toMs === undefined || value.toMs >= value.fromMs, {
    message: 'toMs must be at least fromMs.',
    path: ['toMs'],
  });
const jobQuery = z.object({
  status: z
    .union([jobStatusSchema, z.array(jobStatusSchema)])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    ),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  ownerId: uuidSchema.optional(),
  printerId: uuidSchema.optional(),
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sort: z
    .enum(['submittedAt', 'completedAt', 'priority', 'wait'])
    .default('submittedAt'),
  direction: z.enum(['asc', 'desc']).default('asc'),
});
const metricsQuery = z.object({
  windowMs: z.coerce.number().int().min(1_000).max(86_400_000).optional(),
});
const auditQuery = z.object({
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  actorId: z.string().min(1).optional(),
  actorKind: z.enum(['USER', 'AGENT', 'SYSTEM']).optional(),
  commandType: z.string().min(1).optional(),
  outcome: z.enum(['ACCEPTED', 'REJECTED', 'FAILED']).optional(),
  correlationId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export function createApiRouter(
  service: SimulationService,
  agentStatuses: () => StateSnapshot['agents'] = () => [],
  enableFaultInjection = false,
): Router {
  const router = Router();
  router.use(authenticate);
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_request, response) => {
        response.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many API requests. Try again shortly.',
            retryable: true,
          },
          meta: response.locals['meta'],
        });
      },
    }),
  );

  router.get('/simulations/:simulationId/state', async (request, response) => {
    const { simulationId } = simulationParams.parse(request.params);
    const coordinator = await service.getCoordinator(simulationId);
    const snapshot = stateResource(simulationId, coordinator);
    send(
      response,
      { ...snapshot, agents: agentStatuses() },
      200,
      coordinator.snapshot().stateVersion,
    );
  });

  router.post(
    '/simulations/:simulationId/actions/pause',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId } = simulationParams.parse(request.params);
      const body = pauseSimulationRequestSchema.parse(request.body);
      const result = await service.mutate(
        simulationId,
        mutationContext(
          request,
          response,
          'PAUSE_SIMULATION',
          200,
          body,
          true,
          true,
        ),
        async (coordinator, meta) => {
          await coordinator.pause(meta);
          return stateResource(simulationId, coordinator).simulation;
        },
      );
      sendMutation(response, result);
    },
  );

  router.post(
    '/simulations/:simulationId/actions/resume',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId } = simulationParams.parse(request.params);
      const body = resumeSimulationRequestSchema.parse(request.body);
      const result = await service.mutate(
        simulationId,
        mutationContext(
          request,
          response,
          'RESUME_SIMULATION',
          200,
          body,
          true,
          true,
        ),
        async (coordinator, meta) => {
          await coordinator.resume(meta, body.speedMultiplier);
          return stateResource(simulationId, coordinator).simulation;
        },
      );
      sendMutation(response, result);
    },
  );

  router.patch('/simulations/:simulationId', async (request, response) => {
    requireRole(response, 'ADMIN');
    const { simulationId } = simulationParams.parse(request.params);
    const body = updateSimulationRequestSchema.parse(request.body);
    const result = await service.mutate(
      simulationId,
      mutationContext(
        request,
        response,
        'UPDATE_SIMULATION',
        200,
        body,
        true,
        true,
      ),
      async (coordinator, meta) => {
        await coordinator.updateSimulation(meta, {
          ...(body.speedMultiplier === undefined
            ? {}
            : { speedMultiplier: body.speedMultiplier }),
          ...(body.queueCapacity === undefined
            ? {}
            : { queueCapacity: body.queueCapacity }),
        });
        return stateResource(simulationId, coordinator).simulation;
      },
    );
    sendMutation(response, result);
  });

  router.post(
    '/simulations/:simulationId/actions/reset',
    async (request, response) => {
      requireRole(response, 'ADMIN');
      const { simulationId } = simulationParams.parse(request.params);
      const body = resetSimulationRequestSchema.parse(request.body);
      if (body.confirmSimulationId !== simulationId)
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'confirmSimulationId must match the route simulation.',
        );
      const operationId = randomUUID();
      const result = await service.mutate(
        simulationId,
        mutationContext(
          request,
          response,
          'RESET_SIMULATION',
          202,
          body,
          true,
          true,
        ),
        async (coordinator, meta) => {
          await coordinator.reset(meta, body.preserveHistory);
          return {
            operationId,
            status: 'COMPLETED' as const,
            simulation: stateResource(simulationId, coordinator).simulation,
          };
        },
      );
      service.clearStalledPrinters(simulationId);
      sendMutation(response, result);
    },
  );

  router.post('/simulations/:simulationId/jobs', async (request, response) => {
    requireRole(response, 'OPERATOR');
    const { simulationId } = simulationParams.parse(request.params);
    const body = createJobRequestSchema.parse(request.body);
    const actor = actorFor(response);
    const result = await service.mutate(
      simulationId,
      mutationContext(request, response, 'CREATE_JOB', 202, body, true),
      async (coordinator, meta) => {
        const job = await coordinator.submitJob(meta, {
          id: randomUUID(),
          ownerId: actor.id,
          input: body,
        });
        return jobResources(simulationId, coordinator).find(
          (resource) => resource.id === job.id,
        );
      },
    );
    sendMutation(response, result);
  });

  router.post(
    '/simulations/:simulationId/jobs/burst',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId } = simulationParams.parse(request.params);
      const body = createBurstRequestSchema.parse(request.body);
      const actor = actorFor(response);
      const generated = generateBurst(body, actor.id);
      const result = await service.mutate(
        simulationId,
        mutationContext(request, response, 'CREATE_BURST', 202, body, true),
        async (coordinator, meta) => {
          const submitted = await coordinator.submitBurst(
            meta,
            generated.submissions,
            body.mode,
          );
          const resources = new Map(
            jobResources(simulationId, coordinator).map((job) => [job.id, job]),
          );
          return {
            accepted: submitted.accepted.map((job) => resources.get(job.id)),
            rejected: submitted.rejected.map((item) => ({
              sourceIndex: generated.submissions.indexOf(item),
              code: 'QUEUE_CAPACITY_EXCEEDED' as const,
              message: 'The active queue is full.',
            })),
            seed: body.seed,
            workloadHash: generated.workloadHash,
          };
        },
      );
      sendMutation(response, result);
    },
  );

  router.get('/simulations/:simulationId/jobs', async (request, response) => {
    const { simulationId } = simulationParams.parse(request.params);
    const query = jobQuery.parse(request.query);
    const coordinator = await service.getCoordinator(simulationId);
    const offset = decodeCursor(query.cursor);
    const nowMs = coordinator.clock.state.simulationTimeMs;
    const terminal = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
    const direction = query.direction === 'asc' ? 1 : -1;
    const filtered = jobResources(simulationId, coordinator)
      .filter(
        (job) =>
          (!query.status || query.status.includes(job.status)) &&
          (!query.ownerId || job.ownerId === query.ownerId) &&
          (!query.printerId || job.assignedPrinterId === query.printerId) &&
          (query.active === undefined ||
            query.active !== terminal.has(job.status)),
      )
      .sort((left, right) => {
        const values = {
          submittedAt: [
            Date.parse(left.submittedAt),
            Date.parse(right.submittedAt),
          ],
          completedAt: [
            left.completedAt
              ? Date.parse(left.completedAt)
              : Number.MAX_SAFE_INTEGER,
            right.completedAt
              ? Date.parse(right.completedAt)
              : Number.MAX_SAFE_INTEGER,
          ],
          priority: [left.effectivePriority, right.effectivePriority],
          wait: [jobWaitMs(left, nowMs), jobWaitMs(right, nowMs)],
        }[query.sort];
        return (
          ((values[0] as number) - (values[1] as number)) * direction ||
          left.sequence - right.sequence
        );
      });
    const items = filtered.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;
    send(
      response,
      {
        items,
        ...(nextOffset < filtered.length
          ? {
              nextCursor: Buffer.from(String(nextOffset)).toString('base64url'),
            }
          : {}),
        hasMore: nextOffset < filtered.length,
      },
      200,
      coordinator.snapshot().stateVersion,
    );
  });

  router.get(
    '/simulations/:simulationId/jobs/:jobId',
    async (request, response) => {
      const { simulationId, jobId } = jobParams.parse(request.params);
      const coordinator = await service.getCoordinator(simulationId);
      const job = jobResources(simulationId, coordinator).find(
        (resource) => resource.id === jobId,
      );
      if (!job) throw new HttpError(404, 'NOT_FOUND', 'Job was not found.');
      const events = await service.repository.readEventsThrough(
        simulationId,
        coordinator.clock.state.simulationTimeMs,
        100_000,
      );
      const timeline = events
        .filter((event) => event.payload.data['jobId'] === jobId)
        .map((event) => ({
          eventId: event.eventId,
          type: event.type,
          occurredAt: event.occurredAt,
          simulationTimeMs: event.simulationTimeMs,
          summary: eventSummary(event.type),
        }));
      const queuedAtMs = simulationMs(job.queuedAt);
      const startedAtMs = job.startedAt
        ? simulationMs(job.startedAt)
        : undefined;
      const endMs = job.completedAt
        ? simulationMs(job.completedAt)
        : coordinator.clock.state.simulationTimeMs;
      const serviceMs =
        startedAtMs === undefined ? 0 : Math.max(0, endMs - startedAtMs);
      send(
        response,
        {
          ...job,
          timeline,
          timing: {
            ...(startedAtMs === undefined
              ? {}
              : {
                  responseMs: startedAtMs - queuedAtMs,
                  waitMs: Math.max(0, endMs - queuedAtMs - serviceMs),
                }),
            serviceMs,
            ...(job.completedAt ? { turnaroundMs: endMs - queuedAtMs } : {}),
          },
        },
        200,
        coordinator.snapshot().stateVersion,
      );
    },
  );

  router.patch(
    '/simulations/:simulationId/jobs/:jobId',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId, jobId } = jobParams.parse(request.params);
      const body = updateJobRequestSchema.parse(request.body);
      const result = await service.mutate(
        simulationId,
        mutationContext(request, response, 'UPDATE_JOB', 200, body, true),
        async (coordinator, meta) => {
          await coordinator.updateJobPriority(
            meta,
            jobId,
            body.basePriority,
            body.expectedJobVersion,
          );
          return jobResources(simulationId, coordinator).find(
            (resource) => resource.id === jobId,
          );
        },
      );
      sendMutation(response, result);
    },
  );

  router.delete(
    '/simulations/:simulationId/jobs/:jobId',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId, jobId } = jobParams.parse(request.params);
      const result = await service.mutate(
        simulationId,
        mutationContext(request, response, 'CANCEL_JOB', 200, {}, true),
        async (coordinator, meta) => {
          await coordinator.cancelJob(meta, jobId);
          return jobResources(simulationId, coordinator).find(
            (resource) => resource.id === jobId,
          );
        },
      );
      sendMutation(response, result);
    },
  );

  router.get(
    '/simulations/:simulationId/printers',
    async (request, response) => {
      const { simulationId } = simulationParams.parse(request.params);
      const coordinator = await service.getCoordinator(simulationId);
      send(
        response,
        stateResource(simulationId, coordinator).printers.sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        ),
        200,
        coordinator.snapshot().stateVersion,
      );
    },
  );

  router.get(
    '/simulations/:simulationId/printers/:printerId',
    async (request, response) => {
      const { simulationId, printerId } = printerParams.parse(request.params);
      const coordinator = await service.getCoordinator(simulationId);
      const printer = stateResource(simulationId, coordinator).printers.find(
        (resource) => resource.id === printerId,
      );
      if (!printer)
        throw new HttpError(404, 'NOT_FOUND', 'Printer was not found.');
      const active = printer.activeJobId
        ? jobResources(simulationId, coordinator).find(
            (job) => job.id === printer.activeJobId,
          )
        : undefined;
      send(
        response,
        {
          ...printer,
          utilization:
            stateResource(simulationId, coordinator).metrics.printerUtilization[
              printer.id
            ] ?? 0,
          ...(active?.startedAt
            ? {
                activeInterval: {
                  jobId: active.id,
                  startedAt: active.startedAt,
                  pagesCompleted: active.pagesCompleted,
                },
              }
            : {}),
        },
        200,
        coordinator.snapshot().stateVersion,
      );
    },
  );

  router.post(
    '/simulations/:simulationId/printers',
    async (request, response) => {
      requireRole(response, 'ADMIN');
      const { simulationId } = simulationParams.parse(request.params);
      const body = createPrinterRequestSchema.parse(request.body);
      const result = await service.mutate(
        simulationId,
        mutationContext(request, response, 'CREATE_PRINTER', 201, body, true),
        async (coordinator, meta) => {
          const printer: PrinterState = {
            id: randomUUID(),
            name: body.name,
            status: body.initialStatus ?? 'READY',
            pagesPerMinute: body.pagesPerMinute,
            supportsColor: body.supportsColor,
            supportsDuplex: body.supportsDuplex,
            version: 0,
          };
          await coordinator.addPrinter(meta, printer);
          return stateResource(simulationId, coordinator).printers.find(
            (resource) => resource.id === printer.id,
          );
        },
      );
      sendMutation(response, result);
    },
  );

  router.patch(
    '/simulations/:simulationId/printers/:printerId',
    async (request, response) => {
      requireRole(response, 'ADMIN');
      const { simulationId, printerId } = printerParams.parse(request.params);
      const body = updatePrinterRequestSchema.parse(request.body);
      const result = await service.mutate(
        simulationId,
        mutationContext(
          request,
          response,
          'UPDATE_PRINTER',
          200,
          body,
          true,
          true,
        ),
        async (coordinator, meta) => {
          await coordinator.updatePrinter(meta, printerId, body);
          return stateResource(simulationId, coordinator).printers.find(
            (printer) => printer.id === printerId,
          );
        },
      );
      sendMutation(response, result);
    },
  );

  router.post(
    '/simulations/:simulationId/printers/:printerId/faults',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      if (!enableFaultInjection) {
        throw new HttpError(
          403,
          'FAULT_INJECTION_DISABLED',
          'Fault injection is disabled in this environment.',
        );
      }
      const { simulationId, printerId } = printerParams.parse(request.params);
      const body = injectPrinterFaultRequestSchema.parse(request.body);
      const result = await service.mutate(
        simulationId,
        mutationContext(
          request,
          response,
          'INJECT_PRINTER_FAULT',
          202,
          body,
          true,
        ),
        async (coordinator, meta) => {
          if (body.fault === 'PAPER_JAM') {
            await coordinator.jamPrinter(meta, printerId);
          } else {
            await coordinator.reportWorkerStall(meta, printerId);
          }
          return stateResource(simulationId, coordinator).printers.find(
            (printer) => printer.id === printerId,
          );
        },
      );
      if (body.fault === 'WORKER_STALL') {
        service.setPrinterStalled(simulationId, printerId, true);
      }
      if (body.fault === 'PAPER_JAM' && body.autoRecoverAfterMs) {
        const timer = setTimeout(() => {
          void service
            .mutate(
              simulationId,
              {
                actor: { id: 'automation-daemon', role: 'ADMIN' },
                actorKind: 'AGENT',
                correlationId: randomUUID(),
                commandType: 'AUTO_RECOVER_PRINTER',
                routeKey: 'agent:auto-recover-printer',
                requestBody: { printerId },
                statusCode: 200,
              },
              async (coordinator, meta) =>
                coordinator.recoverPrinter(meta, printerId, true),
            )
            .catch(() => undefined);
        }, body.autoRecoverAfterMs);
        timer.unref();
      }
      sendMutation(response, result);
    },
  );

  router.post(
    '/simulations/:simulationId/printers/:printerId/actions/recover',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId, printerId } = printerParams.parse(request.params);
      const body = recoverPrinterRequestSchema.parse(request.body);
      const stalled = service.isPrinterStalled(simulationId, printerId);
      const result = await service.mutate(
        simulationId,
        mutationContext(request, response, 'RECOVER_PRINTER', 200, body, true),
        async (coordinator, meta) => {
          if (stalled)
            await coordinator.reportWorkerResponsive(meta, printerId);
          else
            await coordinator.recoverPrinter(
              meta,
              printerId,
              body.resumeInterruptedJob,
            );
          return stateResource(simulationId, coordinator).printers.find(
            (printer) => printer.id === printerId,
          );
        },
      );
      if (stalled) service.setPrinterStalled(simulationId, printerId, false);
      sendMutation(response, result);
    },
  );

  router.get(
    '/simulations/:simulationId/printers/:printerId/mutex',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId, printerId } = printerParams.parse(request.params);
      const coordinator = await service.getCoordinator(simulationId);
      const printer = stateResource(simulationId, coordinator).printers.find(
        (candidate) => candidate.id === printerId,
      );
      if (!printer)
        throw new HttpError(404, 'NOT_FOUND', 'Printer was not found.');
      send(response, printer.mutex, 200, coordinator.snapshot().stateVersion);
    },
  );

  router.get(
    '/simulations/:simulationId/scheduler',
    async (request, response) => {
      const { simulationId } = simulationParams.parse(request.params);
      const coordinator = await service.getCoordinator(simulationId);
      send(
        response,
        {
          ...coordinator.scheduler,
          starvationWarningMs: 30_000,
          revision: coordinator.snapshot().stateVersion,
          comparator:
            'Stable non-preemptive selection; ties use queue time then sequence.',
        },
        200,
        coordinator.snapshot().stateVersion,
      );
    },
  );

  router.put(
    '/simulations/:simulationId/scheduler',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId } = simulationParams.parse(request.params);
      const body = updateSchedulerRequestSchema.parse(request.body);
      const result = await service.mutate(
        simulationId,
        mutationContext(
          request,
          response,
          'UPDATE_SCHEDULER',
          200,
          body,
          true,
          true,
        ),
        async (coordinator, meta) => {
          const current = coordinator.scheduler;
          await coordinator.updateScheduler(meta, {
            algorithm: body.algorithm,
            agingIntervalMs:
              body.aging?.agingIntervalMs ?? current.agingIntervalMs,
            agingFactor: body.aging?.agingFactor ?? current.agingFactor,
            priorityCap: body.aging?.priorityCap ?? current.priorityCap,
          });
          return stateResource(simulationId, coordinator).simulation.scheduler;
        },
      );
      sendMutation(response, result);
    },
  );

  router.post(
    '/simulations/:simulationId/scheduler/rebalance',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId } = simulationParams.parse(request.params);
      const body = rebalanceRequestSchema.parse(request.body);
      const view = (
        coordinator: Awaited<ReturnType<SimulationService['getCoordinator']>>,
      ) => {
        const snapshot = coordinator.snapshot();
        const ranking = rankJobs(
          snapshot.jobs,
          snapshot.printers,
          coordinator.scheduler,
          coordinator.clock.state.simulationTimeMs,
        );
        return {
          algorithm: coordinator.scheduler.algorithm,
          orderedJobIds: ranking.decisions.map((decision) => decision.jobId),
          placements: ranking.decisions.map((decision) => ({
            jobId: decision.jobId,
            rank: decision.explanation.rank,
            explanation: decision.explanation.summary,
          })),
          applied: !body.dryRun,
        };
      };
      if (body.dryRun) {
        const coordinator = await service.getCoordinator(simulationId);
        send(
          response,
          view(coordinator),
          200,
          coordinator.snapshot().stateVersion,
        );
        return;
      }
      const result = await service.mutate(
        simulationId,
        mutationContext(
          request,
          response,
          'REBALANCE_QUEUE',
          200,
          body,
          true,
          true,
        ),
        async (coordinator, meta) => {
          await coordinator.rebalance(meta);
          return view(coordinator);
        },
      );
      sendMutation(response, result);
    },
  );

  router.get(
    '/simulations/:simulationId/metrics',
    async (request, response) => {
      const { simulationId } = simulationParams.parse(request.params);
      const query = metricsQuery.parse(request.query);
      const coordinator = await service.getCoordinator(simulationId);
      send(
        response,
        metricsResource(
          coordinator,
          jobResources(simulationId, coordinator),
          undefined,
          query.windowMs,
        ),
        200,
        coordinator.snapshot().stateVersion,
      );
    },
  );

  router.get(
    '/simulations/:simulationId/analytics/timeline',
    async (request, response) => {
      const { simulationId } = simulationParams.parse(request.params);
      const query = timelineQuery.parse(request.query);
      const coordinator = await service.getCoordinator(simulationId);
      const toMs = query.toMs ?? coordinator.clock.state.simulationTimeMs;
      const events = await service.repository.readEventsThrough(
        simulationId,
        toMs,
        query.limit,
      );
      const timeline = buildTimeline(
        events,
        coordinator.snapshot().printers.map((printer) => printer.id),
        query.fromMs,
        toMs,
        {
          ...(query.printerId ? { printerId: query.printerId } : {}),
          ...(query.jobId ? { jobId: query.jobId } : {}),
        },
      );
      send(response, timeline, 200, coordinator.snapshot().stateVersion);
    },
  );

  router.post(
    '/simulations/:simulationId/benchmarks',
    async (request, response) => {
      requireRole(response, 'OPERATOR');
      const { simulationId } = simulationParams.parse(request.params);
      const body = benchmarkRequestSchema.parse(request.body);
      const idempotencyKey = request.header('Idempotency-Key');
      if (!idempotencyKey)
        throw new HttpError(
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'An Idempotency-Key header is required.',
        );
      if (body.source.kind === 'SAVED_WORKLOAD')
        throw new HttpError(404, 'NOT_FOUND', 'Saved workload was not found.');
      const coordinator = await service.getCoordinator(simulationId);
      const nowMs = coordinator.clock.state.simulationTimeMs;
      const jobs =
        body.source.kind === 'EXPLICIT'
          ? body.source.jobs
          : coordinator
              .snapshot()
              .jobs.filter(
                (job) =>
                  !['COMPLETED', 'CANCELLED', 'FAILED'].includes(job.status),
              )
              .map((job) => ({
                id: job.id,
                arrivalTimeMs: Math.max(0, job.queuedAtMs - nowMs),
                pages: job.pages - job.pagesCompleted,
                priority: job.basePriority,
                colorMode: job.colorMode,
                duplex: job.duplex,
              }));
      const benchmarkId = deterministicCommandId(
        simulationId,
        actorFor(response).id,
        idempotencyKey,
      );
      const existing = await service.repository.readBenchmark(
        simulationId,
        benchmarkId,
      );
      if (existing) {
        if (requestHash(existing.request) !== requestHash(body))
          throw new HttpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used with a different benchmark request.',
          );
        response.setHeader('Idempotency-Replayed', 'true');
        send(
          response,
          {
            benchmarkId,
            status: 'RUNNING',
            workloadHash: existing.workloadHash,
            statusUrl: `/api/v1/simulations/${simulationId}/benchmarks/${benchmarkId}`,
          },
          202,
          coordinator.snapshot().stateVersion,
        );
        return;
      }
      let result;
      try {
        result = runBenchmark(body, jobs, benchmarkId);
      } catch (error) {
        if (
          error instanceof RangeError &&
          error.message.includes('execution limit')
        )
          throw new HttpError(409, 'BENCHMARK_LIMIT_EXCEEDED', error.message);
        throw error;
      }
      await service.repository.saveBenchmark({
        id: benchmarkId,
        simulationId,
        workloadHash: result.workloadHash,
        status: 'COMPLETED',
        request: body,
        result,
        actorId: actorFor(response).id,
        correlationId: metaFor(response).correlationId,
      });
      response.status(202).json({
        data: {
          benchmarkId,
          status: 'RUNNING',
          workloadHash: result.workloadHash,
          statusUrl: `/api/v1/simulations/${simulationId}/benchmarks/${benchmarkId}`,
        },
        meta: {
          ...metaFor(response),
          stateVersion: coordinator.snapshot().stateVersion,
        },
      });
    },
  );

  router.get(
    '/simulations/:simulationId/benchmarks/:benchmarkId',
    async (request, response) => {
      const { simulationId, benchmarkId } = benchmarkParams.parse(
        request.params,
      );
      const benchmark = await service.repository.readBenchmark(
        simulationId,
        benchmarkId,
      );
      if (!benchmark)
        throw new HttpError(404, 'NOT_FOUND', 'Benchmark was not found.');
      const coordinator = await service.getCoordinator(simulationId);
      send(
        response,
        benchmark.result ?? {
          benchmarkId,
          status: benchmark.status,
          workloadHash: benchmark.workloadHash,
        },
        200,
        coordinator.snapshot().stateVersion,
      );
    },
  );

  router.get(
    '/simulations/:simulationId/benchmarks/:benchmarkId/export',
    async (request, response) => {
      const { simulationId, benchmarkId } = benchmarkParams.parse(
        request.params,
      );
      const format = z
        .enum(['json', 'csv'])
        .default('json')
        .parse(request.query['format']);
      const benchmark = await service.repository.readBenchmark(
        simulationId,
        benchmarkId,
      );
      if (!benchmark?.result)
        throw new HttpError(
          404,
          'NOT_FOUND',
          'Completed benchmark was not found.',
        );
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="benchmark-${benchmarkId}.${format}"`,
      );
      if (format === 'json') {
        response
          .type('application/json')
          .send(JSON.stringify(benchmark.result));
        return;
      }
      const result = benchmark.result as ReturnType<typeof runBenchmark>;
      const rows = result.evaluations.map(({ metrics }) =>
        [
          metrics.algorithm,
          metrics.averageWaitMs,
          metrics.medianWaitMs,
          metrics.p95WaitMs,
          metrics.maximumWaitMs,
          metrics.averageTurnaroundMs,
          metrics.makespanMs,
          metrics.throughputJobsPerMinute,
          metrics.printerUtilization,
          metrics.fairnessIndex,
          metrics.starvationCount,
        ].join(','),
      );
      response
        .type('text/csv')
        .send(
          [
            'algorithm,averageWaitMs,medianWaitMs,p95WaitMs,maximumWaitMs,averageTurnaroundMs,makespanMs,throughputJobsPerMinute,printerUtilization,fairnessIndex,starvationCount',
            ...rows,
          ].join('\n'),
        );
    },
  );

  router.get('/simulations/:simulationId/audit', async (request, response) => {
    requireRole(response, 'ADMIN');
    const { simulationId } = simulationParams.parse(request.params);
    const query = auditQuery.parse(request.query);
    const offset = decodeCursor(query.cursor);
    const page = await service.repository.readAudit(
      simulationId,
      {
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.actorKind ? { actorKind: query.actorKind } : {}),
        ...(query.commandType ? { commandType: query.commandType } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      },
      offset,
      query.limit,
    );
    const coordinator = await service.getCoordinator(simulationId);
    send(
      response,
      {
        items: page.items,
        ...(page.hasMore
          ? {
              nextCursor: Buffer.from(String(offset + query.limit)).toString(
                'base64url',
              ),
            }
          : {}),
        hasMore: page.hasMore,
      },
      200,
      coordinator.snapshot().stateVersion,
    );
  });

  return router;
}

function authenticate(request: Request, response: Response, next: () => void) {
  const id = uuidSchema.safeParse(request.header('X-User-Id'));
  const role = roleSchema.safeParse(request.header('X-User-Role'));
  if (!id.success || !role.success) {
    throw new HttpError(
      401,
      'UNAUTHENTICATED',
      'Valid X-User-Id and X-User-Role headers are required.',
    );
  }
  response.locals['actor'] = { id: id.data, role: role.data };
  next();
}

function actorFor(response: Response): { id: string; role: Role } {
  return response.locals['actor'] as { id: string; role: Role };
}

function requireRole(response: Response, minimum: 'OPERATOR' | 'ADMIN'): void {
  const actor = actorFor(response);
  const allowed =
    minimum === 'ADMIN'
      ? actor.role === 'ADMIN'
      : actor.role === 'OPERATOR' || actor.role === 'ADMIN';
  if (!allowed) {
    throw new HttpError(
      403,
      'FORBIDDEN',
      'This action requires a higher role.',
    );
  }
}

function mutationContext(
  request: Request,
  response: Response,
  commandType: string,
  statusCode: number,
  requestBody: unknown = request.body,
  requireIdempotency = false,
  requireStateVersion = false,
): MutationContext {
  const idempotencyKey = request.header('Idempotency-Key');
  if (requireIdempotency && !idempotencyKey) {
    throw new HttpError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header is required.',
    );
  }
  const expectedStateVersion = parseIfMatch(request);
  if (requireStateVersion && expectedStateVersion === undefined) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'An If-Match state version header is required.',
    );
  }
  return {
    actor: actorFor(response),
    correlationId: metaFor(response).correlationId,
    commandType,
    routeKey: `${request.method}:${request.route.path as string}`,
    requestBody,
    ...(expectedStateVersion === undefined ? {} : { expectedStateVersion }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    statusCode,
  };
}

function parseIfMatch(request: Request): number | undefined {
  const value = request.header('If-Match');
  if (!value) return undefined;
  const match = /^(?:W\/)?"(\d+)"$/.exec(value);
  if (!match) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'If-Match must be a quoted state version.',
    );
  }
  return Number(match[1]);
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Cursor is invalid.');
  }
  return value;
}

function metaFor(response: Response) {
  return response.locals['meta'] as {
    requestId: string;
    correlationId: string;
    servedAt: string;
  };
}

function send(
  response: Response,
  data: unknown,
  status: number,
  stateVersion: number,
) {
  response.setHeader('ETag', `"${stateVersion}"`);
  response.status(status).json({
    data,
    meta: { ...metaFor(response), stateVersion },
  });
}

function sendMutation(
  response: Response,
  result: {
    value: unknown;
    stateVersion: number;
    statusCode: number;
    replayed: boolean;
  },
) {
  if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
  send(response, result.value, result.statusCode, result.stateVersion);
}

function jobWaitMs(
  job: ReturnType<typeof jobResources>[number],
  nowMs: number,
): number {
  const queuedAtMs = simulationMs(job.queuedAt);
  const endMs = job.startedAt ? simulationMs(job.startedAt) : nowMs;
  return Math.max(0, endMs - queuedAtMs);
}

function simulationMs(timestamp: string): number {
  return Date.parse(timestamp) - Date.UTC(2026, 0, 1);
}

function eventSummary(type: string): string {
  return type
    .toLowerCase()
    .split('_')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function deterministicCommandId(
  simulationId: string,
  actorId: string,
  key: string,
): string {
  const value = createHash('sha256')
    .update(`${simulationId}:${actorId}:${key}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  value[12] = '4';
  value[16] = '8';
  const hex = value.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
