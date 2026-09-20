import { randomUUID } from 'node:crypto';
import type {
  CoordinatorSnapshot,
  DomainEvent,
  PageCommit,
  QueueCoordinator,
  WorkerAssignment,
} from '../coordinator.js';

export interface WorkerRunOptions {
  readonly beforePageCommit?: (
    assignment: WorkerAssignment,
    snapshot: CoordinatorSnapshot,
  ) => void | Promise<void>;
  readonly onEvents?: (events: readonly DomainEvent[]) => void;
  readonly maxPageCommits?: number;
}

class PrinterWorker {
  assignment: WorkerAssignment | null = null;
  nextPageAtMs = 0;

  constructor(
    readonly printerId: string,
    readonly coordinator: QueueCoordinator,
  ) {}

  async dispatch(): Promise<void> {
    const snapshot = this.coordinator.snapshot();
    this.assignment = await this.coordinator.dispatch(
      {
        commandId: randomUUID(),
        expectedStateVersion: snapshot.stateVersion,
      },
      this.printerId,
    );
    if (this.assignment) {
      this.nextPageAtMs =
        this.coordinator.clock.state.simulationTimeMs +
        this.assignment.pageDurationMs;
    }
  }

  async commitPage(): Promise<PageCommit> {
    const assignment = this.assignment;
    if (!assignment) throw new Error('Worker has no active assignment.');
    const result = await this.coordinator.advancePage(
      { commandId: randomUUID() },
      this.printerId,
      assignment.lease.leaseId,
      assignment.lease.fenceToken,
    );
    if (result.terminal) this.assignment = null;
    else this.nextPageAtMs += assignment.pageDurationMs;
    return result;
  }
}

export class PrinterWorkerPool {
  readonly #workers: PrinterWorker[];

  constructor(
    readonly coordinator: QueueCoordinator,
    printerIds = coordinator.snapshot().printers.map((printer) => printer.id),
  ) {
    this.#workers = printerIds.map(
      (printerId) => new PrinterWorker(printerId, coordinator),
    );
  }

  async runUntilIdle(
    options: WorkerRunOptions = {},
  ): Promise<CoordinatorSnapshot> {
    const maxPageCommits = options.maxPageCommits ?? 1_000_000;
    let pageCommits = 0;
    this.#flushEvents(options);

    while (true) {
      if (this.coordinator.clock.state.paused) break;
      await this.coordinator.activateArrivals({ commandId: randomUUID() });
      for (const worker of this.#workers) {
        if (!worker.assignment) await worker.dispatch();
      }
      this.#flushEvents(options);

      const active = this.#workers.filter((worker) => worker.assignment);
      if (active.length === 0) {
        const futureArrival = this.coordinator
          .snapshot()
          .jobs.filter((job) => job.status === 'QUEUED')
          .reduce<number | null>(
            (earliest, job) =>
              earliest === null
                ? job.queuedAtMs
                : Math.min(earliest, job.queuedAtMs),
            null,
          );
        if (futureArrival === null) break;
        this.coordinator.clock.advanceSimulationBy(
          futureArrival - this.coordinator.clock.state.simulationTimeMs,
        );
        continue;
      }

      const nextPageAtMs = Math.min(
        ...active.map((worker) => worker.nextPageAtMs),
      );
      this.coordinator.clock.advanceSimulationBy(
        Math.max(
          0,
          nextPageAtMs - this.coordinator.clock.state.simulationTimeMs,
        ),
      );
      for (const worker of active.filter(
        (candidate) => candidate.nextPageAtMs === nextPageAtMs,
      )) {
        const assignment = worker.assignment as WorkerAssignment;
        await options.beforePageCommit?.(
          assignment,
          this.coordinator.snapshot(),
        );
        await worker.commitPage();
        pageCommits += 1;
        if (pageCommits > maxPageCommits) {
          throw new Error('Worker pool exceeded its page-commit safety limit.');
        }
      }
      this.#flushEvents(options);
    }

    const snapshot = this.coordinator.snapshot();
    this.coordinator.assertInvariants();
    return snapshot;
  }

  #flushEvents(options: WorkerRunOptions): void {
    const events = this.coordinator.drainEvents();
    if (events.length > 0) options.onEvents?.(events);
  }
}
