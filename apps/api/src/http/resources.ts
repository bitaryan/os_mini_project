import type {
  JobResource,
  MetricsResource,
  PrinterResource,
  StateSnapshot,
} from '@printer/contracts';
import {
  calculateJobTiming,
  effectivePriority,
  rankJobs,
  summarize,
  throughputJobsPerMinute,
  type CoordinatorSnapshot,
  type QueueCoordinator,
} from '../domain/index.js';

const simulationEpochMs = Date.UTC(2026, 0, 1);
const starvationWarningMs = 30_000;

export function stateResource(
  simulationId: string,
  coordinator: QueueCoordinator,
): StateSnapshot {
  const snapshot = coordinator.snapshot();
  const jobs = jobResources(simulationId, coordinator, snapshot);
  const alerts = jobs
    .filter(
      (job) =>
        ['QUEUED', 'READY', 'BLOCKED'].includes(job.status) &&
        coordinator.clock.state.simulationTimeMs -
          (Date.parse(job.queuedAt) - simulationEpochMs) >=
          starvationWarningMs,
    )
    .map((job) => ({
      id: job.id,
      severity: 'WARNING' as const,
      code: 'STARVATION_WARNING_RAISED',
      message: `${job.documentName} has waited at least ${starvationWarningMs / 1_000} seconds.`,
      raisedAt: iso(
        Date.parse(job.queuedAt) - simulationEpochMs + starvationWarningMs,
      ),
      resourceId: job.id,
    }));
  return {
    simulation: {
      id: simulationId,
      status: coordinator.clock.state.paused ? 'PAUSED' : 'RUNNING',
      simulationTimeMs: coordinator.clock.state.simulationTimeMs,
      speedMultiplier: coordinator.clock.state.speedMultiplier,
      queueCapacity: snapshot.queueCapacity,
      queueUsed: snapshot.activeBufferJobIds.length,
      stateVersion: snapshot.stateVersion,
      scheduler: {
        ...coordinator.scheduler,
        starvationWarningMs,
        revision: snapshot.stateVersion,
      },
    },
    jobs,
    printers: snapshot.printers.map((printer) =>
      printerResource(simulationId, printer),
    ),
    metrics: metricsResource(coordinator, jobs, alerts.length),
    agents: [],
    alerts,
  };
}

export function jobResources(
  simulationId: string,
  coordinator: QueueCoordinator,
  snapshot = coordinator.snapshot(),
): JobResource[] {
  const ranking = rankJobs(
    snapshot.jobs,
    snapshot.printers,
    coordinator.scheduler,
    coordinator.clock.state.simulationTimeMs,
  );
  const decisions = new Map(
    ranking.decisions.map((decision) => [decision.jobId, decision]),
  );
  return snapshot.jobs.map((job) => {
    const decision = decisions.get(job.id);
    return {
      id: job.id,
      simulationId,
      ownerId: job.ownerId,
      documentName: job.documentName,
      pages: job.pages,
      pagesCompleted: job.pagesCompleted,
      pagesRemaining: job.pages - job.pagesCompleted,
      basePriority: job.basePriority,
      effectivePriority: effectivePriority(
        job,
        coordinator.clock.state.simulationTimeMs,
        coordinator.scheduler,
      ),
      colorMode: job.colorMode,
      duplex: job.duplex,
      status: job.status,
      ...(job.status === 'BLOCKED'
        ? { blockReason: 'NO_COMPATIBLE_PRINTER' as const }
        : {}),
      submittedAt: iso(job.submittedAtMs),
      queuedAt: iso(job.queuedAtMs),
      ...(job.startedAtMs === undefined
        ? {}
        : { startedAt: iso(job.startedAtMs) }),
      ...(job.completedAtMs === undefined
        ? {}
        : { completedAt: iso(job.completedAtMs) }),
      ...(job.assignedPrinterId
        ? { assignedPrinterId: job.assignedPrinterId }
        : {}),
      ...(job.cancellationRequestedAtMs === undefined
        ? {}
        : { cancellationRequestedAt: iso(job.cancellationRequestedAtMs) }),
      ...(job.lastProgressAtMs === undefined
        ? {}
        : { lastProgressAt: iso(job.lastProgressAtMs) }),
      retryCount: job.retryCount,
      ...(decision ? { rank: decision.explanation.rank } : {}),
      sequence: job.sequence,
      version: job.version,
      ...(decision
        ? { schedulerExplanation: decision.explanation.summary }
        : {}),
    };
  });
}

export function metricsResource(
  coordinator: QueueCoordinator,
  jobs = jobResources('00000000-0000-4000-8000-000000000000', coordinator),
  warningCount?: number,
  requestedWindowMs?: number,
): MetricsResource {
  const nowMs = coordinator.clock.state.simulationTimeMs;
  const sampleWindowMs = requestedWindowMs ?? Math.max(1, nowMs);
  const windowStartMs = Math.max(0, nowMs - sampleWindowMs);
  const completed = jobs.filter(
    (job) =>
      job.sequence >= coordinator.metricsSequenceStart &&
      job.status === 'COMPLETED' &&
      job.startedAt &&
      job.completedAt &&
      Date.parse(job.completedAt) - simulationEpochMs >= windowStartMs,
  );
  const timings = completed.map((job) =>
    calculateJobTiming({
      arrivalMs: Date.parse(job.queuedAt) - simulationEpochMs,
      firstStartMs: Date.parse(job.startedAt as string) - simulationEpochMs,
      completionMs: Date.parse(job.completedAt as string) - simulationEpochMs,
      serviceMs:
        Date.parse(job.completedAt as string) -
        Date.parse(job.startedAt as string),
    }),
  );
  const waits = summarize(timings.map((timing) => timing.waitMs));
  const turnarounds = summarize(timings.map((timing) => timing.turnaroundMs));
  const snapshot = coordinator.snapshot();
  const starvationWarningCount =
    warningCount ??
    jobs.filter(
      (job) =>
        ['QUEUED', 'READY', 'BLOCKED'].includes(job.status) &&
        coordinator.clock.state.simulationTimeMs -
          (Date.parse(job.queuedAt) - simulationEpochMs) >=
          starvationWarningMs,
    ).length;
  return {
    sampleWindowMs,
    capturedAt: new Date().toISOString(),
    queuedJobs: jobs.filter((job) =>
      ['QUEUED', 'READY', 'BLOCKED'].includes(job.status),
    ).length,
    activeJobs: jobs.filter((job) =>
      ['PRINTING', 'PAUSED'].includes(job.status),
    ).length,
    completedJobs: completed.length,
    failedJobs: jobs.filter(
      (job) =>
        job.sequence >= coordinator.metricsSequenceStart &&
        job.status === 'FAILED',
    ).length,
    throughputJobsPerMinute: throughputJobsPerMinute(
      completed.length,
      sampleWindowMs,
    ),
    averageWaitMs: waits.average,
    medianWaitMs: waits.median,
    p95WaitMs: waits.p95,
    averageTurnaroundMs: turnarounds.average,
    starvationWarningCount,
    printerUtilization: Object.fromEntries(
      snapshot.printers.map((printer) => {
        const active = jobs.find(
          (job) => job.assignedPrinterId === printer.id && job.startedAt,
        );
        const busyMs = active
          ? Math.max(
              0,
              coordinator.clock.state.simulationTimeMs -
                (Date.parse(active.startedAt as string) - simulationEpochMs),
            )
          : 0;
        return [
          printer.id,
          Math.min(
            1,
            busyMs / Math.max(1, coordinator.clock.state.simulationTimeMs),
          ),
        ];
      }),
    ),
  };
}

function printerResource(
  simulationId: string,
  printer: CoordinatorSnapshot['printers'][number],
): PrinterResource {
  return {
    id: printer.id,
    simulationId,
    name: printer.name,
    status: printer.status,
    pagesPerMinute: printer.pagesPerMinute,
    supportsColor: printer.supportsColor,
    supportsDuplex: printer.supportsDuplex,
    ...(printer.activeJobId ? { activeJobId: printer.activeJobId } : {}),
    mutex: {
      locked: printer.mutex.locked,
      ...(printer.mutex.ownerWorkerId
        ? { ownerWorkerId: printer.mutex.ownerWorkerId }
        : {}),
      ...(printer.mutex.leaseId ? { leaseId: printer.mutex.leaseId } : {}),
      ...(printer.mutex.acquiredAtMs === undefined
        ? {}
        : { acquiredAt: iso(printer.mutex.acquiredAtMs) }),
      ...(printer.mutex.expiresAtMs === undefined
        ? {}
        : { expiresAt: iso(printer.mutex.expiresAtMs) }),
      fenceToken: printer.mutex.fenceToken,
      waiters: printer.mutex.waiters,
    },
    version: printer.version,
  };
}

function iso(simulationTimeMs: number): string {
  return new Date(simulationEpochMs + simulationTimeMs).toISOString();
}
