import { randomUUID } from 'node:crypto';
import type { SubmitJobInput, UpdatePrinterRequest } from '@printer/contracts';
import type { SpeedMultiplier } from '@printer/contracts';
import { SimulationClock } from './clock.js';
import type {
  DomainSchedulerConfig,
  PrinterState,
  PrintJob,
} from './entities.js';
import { isTerminalStatus } from './entities.js';
import { DomainError } from './errors.js';
import { assertJobInvariants, transitionJob } from './lifecycle.js';
import { rankJobs, selectNextJob } from './scheduling/index.js';
import {
  BinaryLeaseMutex,
  BoundedBuffer,
  CountingSemaphore,
  FairMutex,
  type BurstMode,
  type LeaseHandle,
  type LeaseInspection,
  type MutexInspection,
  type SemaphorePermit,
} from './synchronization/index.js';

export interface CommandMeta {
  readonly commandId: string;
  readonly correlationId?: string;
  readonly expectedStateVersion?: number;
}

export interface JobSubmission {
  readonly id: string;
  readonly ownerId: string;
  readonly input: SubmitJobInput;
}

export interface DomainEvent {
  readonly type: string;
  readonly stateVersion: number;
  readonly simulationTimeMs: number;
  readonly correlationId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PrinterSnapshot extends PrinterState {
  readonly mutex: LeaseInspection;
}

export interface CoordinatorSnapshot {
  readonly stateVersion: number;
  readonly queueCapacity: number;
  readonly activeBufferJobIds: readonly string[];
  readonly availablePrinterPermits: number;
  readonly jobs: readonly PrintJob[];
  readonly printers: readonly PrinterSnapshot[];
  readonly queueMutex: MutexInspection;
}

export interface WorkerAssignment {
  readonly printerId: string;
  readonly workerId: string;
  readonly job: PrintJob;
  readonly lease: LeaseHandle;
  readonly pageDurationMs: number;
}

export interface PageCommit {
  readonly job: PrintJob;
  readonly terminal: boolean;
}

export interface CoordinatorState {
  readonly stateVersion: number;
  readonly nextSequence: number;
  readonly metricsSequenceStart?: number;
  readonly queueCapacity: number;
  readonly workerLeaseMs: number;
  readonly clock: {
    readonly simulationTimeMs: number;
    readonly speedMultiplier: SpeedMultiplier;
    readonly paused: boolean;
  };
  readonly scheduler: DomainSchedulerConfig;
  readonly jobs: readonly PrintJob[];
  readonly printers: readonly PrinterState[];
  readonly printerLeases?: Readonly<Record<string, LeaseInspection>>;
}

interface ActiveWorker {
  readonly lease: LeaseHandle;
  readonly permit: SemaphorePermit;
  readonly workerId: string;
}

type CommandRecord =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

export class QueueCoordinator {
  readonly #queueMutex = new FairMutex();
  readonly #buffer: BoundedBuffer<string>;
  readonly #printerPermits: CountingSemaphore;
  readonly #printerMutexes = new Map<string, BinaryLeaseMutex>();
  readonly #unavailablePermits = new Map<string, SemaphorePermit>();
  readonly #activeWorkers = new Map<string, ActiveWorker>();
  readonly #jobs = new Map<string, PrintJob>();
  readonly #printers = new Map<string, PrinterState>();
  readonly #commandResults = new Map<string, CommandRecord>();
  readonly #events: DomainEvent[] = [];
  #scheduler: DomainSchedulerConfig;
  #stateVersion = 0;
  #nextSequence = 1;
  #metricsSequenceStart = 1;

  constructor(
    readonly clock: SimulationClock,
    scheduler: DomainSchedulerConfig,
    printers: readonly PrinterState[],
    queueCapacity = 1_000,
    readonly workerLeaseMs = 300_000,
  ) {
    this.#scheduler = { ...scheduler };
    this.#buffer = new BoundedBuffer(queueCapacity, (id) => id);
    this.#printerPermits = new CountingSemaphore(printers.length);
    const ids = new Set<string>();
    for (const printer of printers) {
      assertPrinter(printer);
      if (ids.has(printer.id)) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'Printer IDs must be unique.',
        );
      }
      ids.add(printer.id);
      this.#printers.set(printer.id, { ...printer });
      this.#printerMutexes.set(
        printer.id,
        new BinaryLeaseMutex(() => this.clock.state.simulationTimeMs),
      );
      if (printer.status !== 'READY') {
        const permit = this.#printerPermits.tryAcquire();
        if (!permit) throw new Error('Printer permit initialization failed.');
        this.#unavailablePermits.set(printer.id, permit);
      }
    }
    this.assertInvariants();
  }

  get scheduler(): DomainSchedulerConfig {
    return { ...this.#scheduler };
  }

  static restore(state: CoordinatorState): QueueCoordinator {
    return QueueCoordinator.#hydrate(state, true);
  }

  static fromState(state: CoordinatorState): QueueCoordinator {
    return QueueCoordinator.#hydrate(state, false);
  }

  fork(): QueueCoordinator {
    return QueueCoordinator.#hydrate(this.exportState(), false);
  }

  static #hydrate(
    state: CoordinatorState,
    recoverActiveWork: boolean,
  ): QueueCoordinator {
    const clock = new SimulationClock({
      simulationTimeMs: state.clock.simulationTimeMs,
      speedMultiplier: state.clock.speedMultiplier,
      paused: recoverActiveWork ? true : state.clock.paused,
    });
    const hydratedPrinters = state.printers.map((printer) => ({
      id: printer.id,
      name: printer.name,
      status: recoverActiveWork
        ? printer.status === 'OFFLINE'
          ? ('OFFLINE' as const)
          : ('READY' as const)
        : printer.activeJobId
          ? ('READY' as const)
          : printer.status === 'READY'
            ? ('READY' as const)
            : ('OFFLINE' as const),
      pagesPerMinute: printer.pagesPerMinute,
      supportsColor: printer.supportsColor,
      supportsDuplex: printer.supportsDuplex,
      version:
        printer.version + (recoverActiveWork && printer.activeJobId ? 1 : 0),
    }));
    const coordinator = new QueueCoordinator(
      clock,
      state.scheduler,
      hydratedPrinters,
      state.queueCapacity,
      state.workerLeaseMs,
    );
    let hadActiveWork = false;
    for (const persisted of state.jobs) {
      const wasActive =
        persisted.status === 'PRINTING' || persisted.status === 'PAUSED';
      const job: PrintJob =
        recoverActiveWork && wasActive
          ? withoutAssignment({
              ...persisted,
              status: 'READY',
              version: persisted.version + 1,
            })
          : { ...persisted };
      coordinator.#jobs.set(job.id, job);
      if (!isTerminalStatus(job.status)) coordinator.#buffer.push(job.id);
      hadActiveWork ||= wasActive;
    }
    if (!recoverActiveWork) {
      for (const printer of state.printers) {
        coordinator.#printers.set(printer.id, { ...printer });
        if (!printer.activeJobId) continue;
        const inspection = state.printerLeases?.[printer.id];
        if (!inspection?.locked || !inspection.ownerWorkerId) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            `Active printer ${printer.id} is missing its worker lease.`,
          );
        }
        const permit = coordinator.#printerPermits.tryAcquire();
        if (!permit) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Active printer permit could not be restored.',
          );
        }
        const mutex = new BinaryLeaseMutex(
          () => coordinator.clock.state.simulationTimeMs,
          inspection,
        );
        coordinator.#printerMutexes.set(printer.id, mutex);
        coordinator.#activeWorkers.set(printer.id, {
          lease: mutex.restoredHandle(),
          permit,
          workerId: inspection.ownerWorkerId,
        });
      }
    }
    coordinator.#nextSequence = state.nextSequence;
    coordinator.#metricsSequenceStart = state.metricsSequenceStart ?? 1;
    coordinator.#stateVersion =
      state.stateVersion + (recoverActiveWork && hadActiveWork ? 1 : 0);
    coordinator.assertInvariants();
    return coordinator;
  }

  exportState(): CoordinatorState {
    return {
      stateVersion: this.#stateVersion,
      nextSequence: this.#nextSequence,
      metricsSequenceStart: this.#metricsSequenceStart,
      queueCapacity: this.#buffer.capacity,
      workerLeaseMs: this.workerLeaseMs,
      clock: this.clock.state,
      scheduler: this.scheduler,
      jobs: [...this.#jobs.values()].map((job) => ({ ...job })),
      printers: [...this.#printers.values()].map((printer) => ({ ...printer })),
      printerLeases: Object.fromEntries(
        [...this.#printerMutexes].map(([printerId, mutex]) => [
          printerId,
          mutex.inspect(),
        ]),
      ),
    };
  }

  snapshot(): CoordinatorSnapshot {
    return {
      stateVersion: this.#stateVersion,
      queueCapacity: this.#buffer.capacity,
      activeBufferJobIds: this.#buffer.snapshot(),
      availablePrinterPermits: this.#printerPermits.inspect().permits,
      jobs: [...this.#jobs.values()].map((job) => ({ ...job })),
      printers: [...this.#printers.values()].map((printer) => ({
        ...printer,
        mutex: this.#mutexFor(printer.id).inspect(),
      })),
      queueMutex: this.#queueMutex.inspect(),
    };
  }

  drainEvents(): readonly DomainEvent[] {
    return this.#events.splice(0);
  }

  get metricsSequenceStart(): number {
    return this.#metricsSequenceStart;
  }

  async submitJob(
    meta: CommandMeta,
    submission: JobSubmission,
  ): Promise<PrintJob> {
    const result = await this.submitBurst(meta, [submission], 'ATOMIC');
    return result.accepted[0] as PrintJob;
  }

  async submitBurst(
    meta: CommandMeta,
    submissions: readonly JobSubmission[],
    mode: BurstMode,
  ): Promise<{
    accepted: readonly PrintJob[];
    rejected: readonly JobSubmission[];
  }> {
    return this.#execute(meta, 'SUBMIT_JOBS', () => {
      const nowMs = this.clock.state.simulationTimeMs;
      const jobs = submissions.map((submission, index) =>
        this.#newJob(submission, this.#nextSequence + index, nowMs),
      );
      const pushed = this.#buffer.pushBurst(
        jobs.map((job) => job.id),
        mode,
      );
      const acceptedIds = new Set(pushed.accepted);
      const accepted = jobs.filter((job) => acceptedIds.has(job.id));
      for (const job of accepted) this.#jobs.set(job.id, job);
      this.#nextSequence += accepted.length;
      if (accepted.length > 0) {
        this.#stateVersion += 1;
        for (const job of accepted) {
          this.#event('JOB_SUBMITTED', meta, {
            jobId: job.id,
            status: job.status,
          });
        }
      }
      return {
        accepted,
        rejected: submissions.slice(accepted.length),
      };
    });
  }

  async activateArrivals(meta: CommandMeta): Promise<readonly PrintJob[]> {
    return this.#execute(meta, 'ACTIVATE_ARRIVALS', () => {
      const nowMs = this.clock.state.simulationTimeMs;
      const activated: PrintJob[] = [];
      for (const job of this.#jobs.values()) {
        if (job.status !== 'QUEUED' || job.queuedAtMs > nowMs) continue;
        const ready = transitionJob(job, 'READY');
        const next = this.#hasCompatiblePrinter(ready)
          ? ready
          : transitionJob(ready, 'BLOCKED');
        this.#jobs.set(job.id, next);
        activated.push(next);
      }
      if (activated.length > 0) {
        this.#stateVersion += 1;
        for (const job of activated) {
          this.#event('JOB_UPDATED', meta, {
            jobId: job.id,
            status: job.status,
          });
        }
      }
      return activated;
    });
  }

  async dispatch(
    meta: CommandMeta,
    requestedPrinterId?: string,
    workerId = randomUUID(),
  ): Promise<WorkerAssignment | null> {
    return this.#execute(meta, 'DISPATCH_NEXT_JOB', async () => {
      if (this.clock.state.paused) return null;
      const readyPrinters = [...this.#printers.values()].filter(
        (printer) => printer.status === 'READY',
      );
      const requestedPrinter = requestedPrinterId
        ? this.#printerFor(requestedPrinterId)
        : undefined;
      if (requestedPrinter && requestedPrinter.status !== 'READY') return null;
      const selection = selectNextJob(
        [...this.#jobs.values()],
        requestedPrinter ? [requestedPrinter] : readyPrinters,
        this.scheduler,
        this.clock.state.simulationTimeMs,
      );
      if (!selection.selected) return null;
      const job = this.#jobFor(selection.selected.jobId);
      const printer = requestedPrinter ?? bestPrinterFor(job, readyPrinters);
      if (!printer) return null;
      const printerId = printer.id;

      const permit = this.#printerPermits.tryAcquire();
      if (!permit) {
        throw new DomainError(
          'RESOURCE_BUSY',
          'No printer permit is available.',
        );
      }
      const pageDurationMs = Math.ceil(60_000 / printer.pagesPerMinute);
      let lease: LeaseHandle;
      try {
        if (
          this.#queueMutex.inspect().ownerId !== `coordinator:${meta.commandId}`
        ) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Printer mutex acquisition requires queue-mutex ownership.',
          );
        }
        lease = await this.#mutexFor(printerId).acquire(
          workerId,
          Math.max(this.workerLeaseMs, pageDurationMs + 1),
          0,
        );
      } catch (error) {
        permit.release();
        throw error;
      }

      let printing: PrintJob;
      try {
        printing = transitionJob(job, 'PRINTING', {
          assignedPrinterId: printerId,
          ...(job.startedAtMs === undefined
            ? { startedAtMs: this.clock.state.simulationTimeMs }
            : {}),
          lastProgressAtMs: this.clock.state.simulationTimeMs,
        });
      } catch (error) {
        lease.release();
        permit.release();
        throw error;
      }
      const printingPrinter: PrinterState = {
        ...printer,
        status: 'PRINTING',
        activeJobId: job.id,
        version: printer.version + 1,
      };
      this.#jobs.set(job.id, printing);
      this.#printers.set(printerId, printingPrinter);
      this.#activeWorkers.set(printerId, { lease, permit, workerId });
      this.#stateVersion += 1;
      this.#event('JOB_DISPATCHED', meta, {
        jobId: job.id,
        printerId,
        workerId,
      });
      const inspection = this.#mutexFor(printerId).inspect();
      this.#event('MUTEX_ACQUIRED', meta, {
        printerId,
        jobId: job.id,
        ownerWorkerId: workerId,
        acquiredAtMs: inspection.acquiredAtMs,
        expiresAtMs: inspection.expiresAtMs,
        fenceToken: inspection.fenceToken,
        waiters: inspection.waiters,
      });
      return { printerId, workerId, job: printing, lease, pageDurationMs };
    });
  }

  async advancePage(
    meta: CommandMeta,
    printerId: string,
    leaseId: string,
    fenceToken: number,
  ): Promise<PageCommit> {
    return this.#execute(meta, 'ADVANCE_ACTIVE_JOB', () => {
      if (this.clock.state.paused) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'A paused simulation cannot advance printer work.',
        );
      }
      const active = this.#activeWorkers.get(printerId);
      if (!active || active.lease.leaseId !== leaseId) {
        throw new DomainError(
          'LOCK_NOT_OWNED',
          'Worker assignment is not active.',
        );
      }
      this.#mutexFor(printerId).assertOwned(leaseId, fenceToken);
      const printer = this.#printerFor(printerId);
      if (printer.status !== 'PRINTING' || !printer.activeJobId) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'A worker can only advance its active printing job.',
        );
      }
      const current = this.#jobFor(printer.activeJobId);
      const pagesCompleted = current.pagesCompleted + 1;
      const progressed: PrintJob = {
        ...current,
        pagesCompleted,
        lastProgressAtMs: this.clock.state.simulationTimeMs,
        version: current.version + 1,
      };
      const terminalStatus =
        current.cancellationRequestedAtMs !== undefined
          ? 'CANCELLED'
          : pagesCompleted === current.pages
            ? 'COMPLETED'
            : null;
      const next = terminalStatus
        ? transitionJob(progressed, terminalStatus, {
            ...(terminalStatus === 'COMPLETED'
              ? { completedAtMs: this.clock.state.simulationTimeMs }
              : {}),
            assignedPrinterId: null,
          })
        : progressed;
      assertJobInvariants(next);
      this.#jobs.set(next.id, next);
      this.#stateVersion += 1;
      this.#event('JOB_PROGRESS_UPDATED', meta, {
        jobId: next.id,
        printerId,
        pagesCompleted,
      });

      if (!terminalStatus) {
        active.lease.renew(
          Math.max(
            this.workerLeaseMs,
            Math.ceil(60_000 / printer.pagesPerMinute) + 1,
          ),
        );
        return { job: next, terminal: false };
      }
      this.#buffer.remove(next.id);
      const readyPrinter: PrinterState = {
        id: printer.id,
        name: printer.name,
        status: 'READY',
        pagesPerMinute: printer.pagesPerMinute,
        supportsColor: printer.supportsColor,
        supportsDuplex: printer.supportsDuplex,
        version: printer.version + 1,
      };
      this.#printers.set(printerId, readyPrinter);
      this.#activeWorkers.delete(printerId);
      const inspection = this.#mutexFor(printerId).inspect();
      active.lease.release();
      active.permit.release();
      this.#event('MUTEX_RELEASED', meta, {
        printerId,
        releasedAtMs: this.clock.state.simulationTimeMs,
        heldForMs: Math.max(
          0,
          this.clock.state.simulationTimeMs - (inspection.acquiredAtMs ?? 0),
        ),
        fenceToken: inspection.fenceToken,
      });
      this.#event(
        terminalStatus === 'COMPLETED' ? 'JOB_COMPLETED' : 'JOB_CANCELLED',
        meta,
        { jobId: next.id, printerId, stoppedAfterPage: pagesCompleted },
      );
      return { job: next, terminal: true };
    });
  }

  async cancelJob(meta: CommandMeta, jobId: string): Promise<PrintJob> {
    return this.#execute(meta, 'CANCEL_JOB', () => {
      const job = this.#jobFor(jobId);
      if (isTerminalStatus(job.status)) {
        throw new DomainError(
          'INVALID_TRANSITION',
          `Cannot cancel a ${job.status.toLowerCase()} job.`,
        );
      }
      if (job.cancellationRequestedAtMs !== undefined) return job;
      let cancelled: PrintJob;
      if (job.status === 'PRINTING' || job.status === 'PAUSED') {
        cancelled = {
          ...job,
          cancellationRequestedAtMs: this.clock.state.simulationTimeMs,
          version: job.version + 1,
        };
      } else {
        cancelled = transitionJob(job, 'CANCELLED', {
          assignedPrinterId: null,
        });
        this.#buffer.remove(job.id);
      }
      assertJobInvariants(cancelled);
      this.#jobs.set(job.id, cancelled);
      this.#stateVersion += 1;
      this.#event(
        cancelled.status === 'CANCELLED'
          ? 'JOB_CANCELLED'
          : 'JOB_CANCELLATION_REQUESTED',
        meta,
        { jobId, status: cancelled.status },
      );
      return cancelled;
    });
  }

  async setPrinterOnline(
    meta: CommandMeta,
    printerId: string,
    online: boolean,
  ): Promise<PrinterState> {
    return this.#execute(meta, 'SET_PRINTER_ONLINE', () => {
      const printer = this.#printerFor(printerId);
      if (printer.status === 'PRINTING') {
        throw new DomainError(
          'INVALID_TRANSITION',
          'An active printer cannot change online state.',
        );
      }
      const target = online ? 'READY' : 'OFFLINE';
      if (printer.status === target) return printer;
      if (online) {
        const permit = this.#unavailablePermits.get(printerId);
        if (!permit) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Offline printer permit is missing.',
          );
        }
        this.#unavailablePermits.delete(printerId);
        permit.release();
      } else {
        const permit = this.#printerPermits.tryAcquire();
        if (!permit) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Ready printer permit is missing.',
          );
        }
        this.#unavailablePermits.set(printerId, permit);
      }
      const updated: PrinterState = {
        ...printer,
        status: target,
        version: printer.version + 1,
      };
      this.#printers.set(printerId, updated);
      this.#stateVersion += 1;
      this.#reconcileCompatibility(meta);
      this.#event('PRINTER_UPDATED', meta, { printerId, status: target });
      return updated;
    });
  }

  async jamPrinter(
    meta: CommandMeta,
    printerId: string,
  ): Promise<PrinterState> {
    return this.#execute(meta, 'INJECT_PAPER_JAM', () => {
      const printer = this.#printerFor(printerId);
      if (printer.status === 'JAMMED') return printer;
      if (printer.status !== 'READY' && printer.status !== 'PRINTING') {
        throw new DomainError(
          'INVALID_TRANSITION',
          'Only ready or printing printers can be jammed.',
        );
      }
      if (printer.status === 'READY') {
        const permit = this.#printerPermits.tryAcquire();
        if (!permit) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Ready printer permit is missing.',
          );
        }
        this.#unavailablePermits.set(printerId, permit);
      } else if (printer.activeJobId) {
        const job = this.#jobFor(printer.activeJobId);
        this.#jobs.set(job.id, transitionJob(job, 'PAUSED'));
      }
      const jammed: PrinterState = {
        ...printer,
        status: 'JAMMED',
        version: printer.version + 1,
      };
      this.#printers.set(printerId, jammed);
      this.#stateVersion += 1;
      this.#event('PRINTER_JAMMED', meta, {
        printerId,
        ...(printer.activeJobId ? { jobId: printer.activeJobId } : {}),
      });
      return jammed;
    });
  }

  async reportWorkerStall(
    meta: CommandMeta,
    printerId: string,
  ): Promise<PrinterState> {
    return this.#execute(meta, 'INJECT_WORKER_STALL', () => {
      const printer = this.#printerFor(printerId);
      if (printer.status !== 'PRINTING' || !printer.activeJobId) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'Only an active printer worker can be stalled.',
        );
      }
      this.#stateVersion += 1;
      this.#event('WORKER_STALL_INJECTED', meta, {
        printerId,
        jobId: printer.activeJobId,
      });
      return printer;
    });
  }

  async reportWorkerResponsive(
    meta: CommandMeta,
    printerId: string,
  ): Promise<PrinterState> {
    return this.#execute(meta, 'RECOVER_WORKER_STALL', () => {
      const printer = this.#printerFor(printerId);
      if (printer.status !== 'PRINTING' || !printer.activeJobId) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'Printer does not have a stalled active worker.',
        );
      }
      const active = this.#activeWorkers.get(printerId);
      if (!active)
        throw new DomainError('LOCK_NOT_OWNED', 'Worker is missing.');
      active.lease.renew(this.workerLeaseMs);
      this.#stateVersion += 1;
      this.#event('WORKER_STALL_CLEARED', meta, {
        printerId,
        jobId: printer.activeJobId,
      });
      return printer;
    });
  }

  async recoverPrinter(
    meta: CommandMeta,
    printerId: string,
    resumeInterruptedJob: boolean,
  ): Promise<PrinterState> {
    return this.#execute(meta, 'RECOVER_PRINTER', () => {
      const printer = this.#printerFor(printerId);
      if (printer.status !== 'JAMMED' && printer.status !== 'ERROR') {
        throw new DomainError(
          'INVALID_TRANSITION',
          'Only jammed or errored printers can be recovered.',
        );
      }
      let status: PrinterState['status'] = 'READY';
      let activeJobId = printer.activeJobId;
      if (activeJobId) {
        const job = this.#jobFor(activeJobId);
        const active = this.#activeWorkers.get(printerId);
        if (!active) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Interrupted printer worker is missing.',
          );
        }
        if (resumeInterruptedJob) {
          this.#jobs.set(job.id, transitionJob(job, 'PRINTING'));
          active.lease.renew(this.workerLeaseMs);
          status = 'PRINTING';
        } else {
          this.#jobs.set(
            job.id,
            transitionJob(job, 'READY', { assignedPrinterId: null }),
          );
          this.#activeWorkers.delete(printerId);
          const inspection = this.#mutexFor(printerId).inspect();
          active.lease.release();
          active.permit.release();
          this.#event('MUTEX_RELEASED', meta, {
            printerId,
            releasedAtMs: this.clock.state.simulationTimeMs,
            heldForMs: Math.max(
              0,
              this.clock.state.simulationTimeMs -
                (inspection.acquiredAtMs ?? 0),
            ),
            fenceToken: inspection.fenceToken,
          });
          activeJobId = undefined;
        }
      } else {
        const unavailable = this.#unavailablePermits.get(printerId);
        if (!unavailable) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Jammed printer permit is missing.',
          );
        }
        this.#unavailablePermits.delete(printerId);
        unavailable.release();
      }
      const recovered: PrinterState = {
        id: printer.id,
        name: printer.name,
        status,
        pagesPerMinute: printer.pagesPerMinute,
        supportsColor: printer.supportsColor,
        supportsDuplex: printer.supportsDuplex,
        ...(activeJobId ? { activeJobId } : {}),
        version: printer.version + 1,
      };
      this.#printers.set(printerId, recovered);
      this.#stateVersion += 1;
      this.#event('PRINTER_RECOVERED', meta, {
        printerId,
        ...(activeJobId ? { jobId: activeJobId } : {}),
      });
      return recovered;
    });
  }

  async recoverStalledJob(
    meta: CommandMeta,
    printerId: string,
  ): Promise<PrintJob> {
    return this.#execute(meta, 'RECOVER_STALLED_JOB', () => {
      const printer = this.#printerFor(printerId);
      if (!printer.activeJobId) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'Printer has no active job.',
        );
      }
      const active = this.#activeWorkers.get(printerId);
      if (!active) {
        throw new DomainError('LOCK_NOT_OWNED', 'Printer worker is missing.');
      }
      const mutex = this.#mutexFor(printerId);
      const fencedLeaseId = active.lease.leaseId;
      const newFenceToken = mutex.fenceExpired(
        fencedLeaseId,
        active.lease.fenceToken,
      );
      const current = this.#jobFor(printer.activeJobId);
      const retryCount = current.retryCount + 1;
      const next =
        retryCount >= 3
          ? transitionJob(current, 'FAILED', {
              retryCount,
              assignedPrinterId: null,
            })
          : transitionJob(
              current.status === 'PRINTING'
                ? transitionJob(current, 'PAUSED', { retryCount })
                : { ...current, retryCount },
              'READY',
              { assignedPrinterId: null },
            );
      this.#jobs.set(next.id, next);
      if (next.status === 'FAILED') this.#buffer.remove(next.id);
      this.#activeWorkers.delete(printerId);
      active.permit.release();
      this.#printers.set(printerId, {
        id: printer.id,
        name: printer.name,
        status: 'READY',
        pagesPerMinute: printer.pagesPerMinute,
        supportsColor: printer.supportsColor,
        supportsDuplex: printer.supportsDuplex,
        version: printer.version + 1,
      });
      this.#stateVersion += 1;
      this.#event('MUTEX_FORCE_RELEASED', meta, {
        printerId,
        jobId: next.id,
        fencedLeaseId,
        newFenceToken,
      });
      this.#event(
        next.status === 'FAILED' ? 'JOB_FAILED' : 'JOB_RECOVERED',
        meta,
        {
          jobId: next.id,
          retryCount,
        },
      );
      return next;
    });
  }

  async addPrinter(
    meta: CommandMeta,
    printer: PrinterState,
  ): Promise<PrinterState> {
    return this.#execute(meta, 'CREATE_PRINTER', () => {
      assertPrinter(printer);
      if (this.#printers.has(printer.id)) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'Printer ID already exists.',
        );
      }
      if (
        [...this.#printers.values()].some(
          (current) => current.name === printer.name,
        )
      ) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'Printer name already exists.',
        );
      }
      this.#printerPermits.addAvailableSlot();
      this.#printers.set(printer.id, { ...printer });
      this.#printerMutexes.set(
        printer.id,
        new BinaryLeaseMutex(() => this.clock.state.simulationTimeMs),
      );
      if (printer.status === 'OFFLINE') {
        const permit = this.#printerPermits.tryAcquire();
        if (!permit) throw new Error('Printer permit initialization failed.');
        this.#unavailablePermits.set(printer.id, permit);
      }
      this.#stateVersion += 1;
      this.#reconcileCompatibility(meta);
      this.#event('PRINTER_CREATED', meta, { printerId: printer.id });
      return printer;
    });
  }

  async updatePrinter(
    meta: CommandMeta,
    printerId: string,
    patch: UpdatePrinterRequest,
  ): Promise<PrinterState> {
    return this.#execute(meta, 'UPDATE_PRINTER', () => {
      const printer = this.#printerFor(printerId);
      if (printer.version !== patch.expectedPrinterVersion) {
        throw new DomainError(
          'STATE_VERSION_CONFLICT',
          `Expected printer version ${patch.expectedPrinterVersion}, actual ${printer.version}.`,
        );
      }
      if (
        patch.name &&
        [...this.#printers.values()].some(
          (candidate) =>
            candidate.id !== printerId && candidate.name === patch.name,
        )
      ) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'Printer name already exists.',
        );
      }
      const supportsColor = patch.supportsColor ?? printer.supportsColor;
      const supportsDuplex = patch.supportsDuplex ?? printer.supportsDuplex;
      if (printer.activeJobId) {
        const job = this.#jobFor(printer.activeJobId);
        if (
          (job.colorMode === 'COLOR' && !supportsColor) ||
          (job.duplex && !supportsDuplex)
        ) {
          throw new DomainError(
            'INVALID_TRANSITION',
            'Capabilities required by the active job cannot be removed.',
          );
        }
        if (patch.online === false) {
          throw new DomainError(
            'INVALID_TRANSITION',
            'An active printer cannot be taken offline.',
          );
        }
      }
      let status = printer.status;
      if (patch.online !== undefined) {
        const target = patch.online ? 'READY' : 'OFFLINE';
        if (
          printer.status === 'PRINTING' ||
          printer.status === 'JAMMED' ||
          printer.status === 'ERROR'
        ) {
          if (printer.status !== 'PRINTING' || patch.online === false)
            throw new DomainError(
              'INVALID_TRANSITION',
              'Recover the printer before changing its online state.',
            );
        } else if (printer.status !== target) {
          if (target === 'OFFLINE') {
            const permit = this.#printerPermits.tryAcquire();
            if (!permit)
              throw new DomainError(
                'INVARIANT_VIOLATION',
                'Ready printer permit is missing.',
              );
            this.#unavailablePermits.set(printerId, permit);
          } else {
            const permit = this.#unavailablePermits.get(printerId);
            if (!permit)
              throw new DomainError(
                'INVARIANT_VIOLATION',
                'Offline printer permit is missing.',
              );
            this.#unavailablePermits.delete(printerId);
            permit.release();
          }
          status = target;
        }
      }
      const updated: PrinterState = {
        ...printer,
        name: patch.name ?? printer.name,
        pagesPerMinute: patch.pagesPerMinute ?? printer.pagesPerMinute,
        supportsColor,
        supportsDuplex,
        status,
        version: printer.version + 1,
      };
      this.#printers.set(printerId, updated);
      this.#stateVersion += 1;
      this.#reconcileCompatibility(meta);
      this.#event('PRINTER_UPDATED', meta, {
        printerId,
        changedFields: Object.keys(patch).filter(
          (field) => field !== 'expectedPrinterVersion',
        ),
        status,
      });
      return updated;
    });
  }

  async updateJobPriority(
    meta: CommandMeta,
    jobId: string,
    basePriority: number,
    expectedJobVersion: number,
  ): Promise<PrintJob> {
    return this.#execute(meta, 'UPDATE_JOB', () => {
      if (
        !Number.isSafeInteger(basePriority) ||
        basePriority < 0 ||
        basePriority > 100
      ) {
        throw new RangeError('Base priority must be an integer from 0 to 100.');
      }
      const job = this.#jobFor(jobId);
      if (job.version !== expectedJobVersion) {
        throw new DomainError(
          'JOB_VERSION_CONFLICT',
          `Expected job version ${expectedJobVersion}, actual ${job.version}.`,
        );
      }
      if (
        job.status !== 'QUEUED' &&
        job.status !== 'READY' &&
        job.status !== 'BLOCKED'
      ) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'Priority can only change before printing begins.',
        );
      }
      const updated: PrintJob = {
        ...job,
        basePriority,
        version: job.version + 1,
      };
      assertJobInvariants(updated);
      this.#jobs.set(jobId, updated);
      this.#stateVersion += 1;
      this.#event('JOB_UPDATED', meta, { jobId, basePriority });
      return updated;
    });
  }

  async updateScheduler(
    meta: CommandMeta,
    scheduler: DomainSchedulerConfig,
  ): Promise<DomainSchedulerConfig> {
    return this.#execute(meta, 'UPDATE_SCHEDULER', () => {
      this.#scheduler = { ...scheduler };
      this.#stateVersion += 1;
      this.#event('SCHEDULER_CONFIG_UPDATED', meta, {
        algorithm: scheduler.algorithm,
      });
      return this.scheduler;
    });
  }

  async rebalance(meta: CommandMeta): Promise<readonly string[]> {
    return this.#execute(meta, 'REBALANCE_QUEUE', () => {
      const orderedJobIds = rankJobs(
        [...this.#jobs.values()],
        [...this.#printers.values()],
        this.#scheduler,
        this.clock.state.simulationTimeMs,
      ).decisions.map((decision) => decision.jobId);
      this.#stateVersion += 1;
      this.#event('QUEUE_REORDERED', meta, { orderedJobIds });
      return orderedJobIds;
    });
  }

  async pause(meta: CommandMeta): Promise<void> {
    await this.#execute(meta, 'PAUSE_SIMULATION', () => {
      if (this.clock.state.paused) return;
      this.clock.pause();
      this.#stateVersion += 1;
      this.#event('SIMULATION_PAUSED', meta, {});
    });
  }

  async updateSimulation(
    meta: CommandMeta,
    update: {
      speedMultiplier?: SpeedMultiplier;
      queueCapacity?: number;
    },
  ): Promise<void> {
    await this.#execute(meta, 'UPDATE_SIMULATION', () => {
      if (update.queueCapacity !== undefined)
        this.#buffer.resize(update.queueCapacity);
      if (update.speedMultiplier !== undefined)
        this.clock.setSpeed(update.speedMultiplier);
      this.#stateVersion += 1;
      this.#event('SIMULATION_UPDATED', meta, update);
      if (update.queueCapacity !== undefined)
        this.#event('QUEUE_CAPACITY_UPDATED', meta, {
          used: this.#buffer.size,
          capacity: this.#buffer.capacity,
        });
    });
  }

  async reset(meta: CommandMeta, preserveHistory: boolean): Promise<void> {
    await this.#execute(meta, 'RESET_SIMULATION', () => {
      for (const [printerId, active] of this.#activeWorkers) {
        try {
          active.lease.release();
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'LEASE_EXPIRED')
            throw error;
          this.#mutexFor(printerId).fenceExpired(
            active.lease.leaseId,
            active.lease.fenceToken,
          );
        }
        active.permit.release();
      }
      this.#activeWorkers.clear();
      for (const permit of this.#unavailablePermits.values()) permit.release();
      this.#unavailablePermits.clear();
      this.#buffer.clear();
      for (const [jobId, job] of this.#jobs) {
        if (!preserveHistory || !isTerminalStatus(job.status))
          this.#jobs.delete(jobId);
      }
      this.#printerMutexes.clear();
      for (const [printerId, printer] of this.#printers) {
        const offline = printer.status === 'OFFLINE';
        this.#printers.set(printerId, {
          id: printer.id,
          name: printer.name,
          status: offline ? 'OFFLINE' : 'READY',
          pagesPerMinute: printer.pagesPerMinute,
          supportsColor: printer.supportsColor,
          supportsDuplex: printer.supportsDuplex,
          version: printer.version + 1,
        });
        this.#printerMutexes.set(
          printerId,
          new BinaryLeaseMutex(() => this.clock.state.simulationTimeMs),
        );
        if (offline) {
          const permit = this.#printerPermits.tryAcquire();
          if (!permit)
            throw new DomainError(
              'INVARIANT_VIOLATION',
              'Offline printer permit could not be restored after reset.',
            );
          this.#unavailablePermits.set(printerId, permit);
        }
      }
      if (!preserveHistory) this.#nextSequence = 1;
      this.#metricsSequenceStart = this.#nextSequence;
      this.clock.reset(true);
      this.#stateVersion += 1;
      this.#event('SIMULATION_RESET', meta, { preserveHistory });
    });
  }

  async resume(
    meta: CommandMeta,
    speedMultiplier?: SpeedMultiplier,
  ): Promise<void> {
    await this.#execute(meta, 'RESUME_SIMULATION', () => {
      const wasPaused = this.clock.state.paused;
      const speedChanged =
        speedMultiplier !== undefined &&
        speedMultiplier !== this.clock.state.speedMultiplier;
      if (!wasPaused && !speedChanged) return;
      if (speedMultiplier !== undefined) this.clock.setSpeed(speedMultiplier);
      if (wasPaused) this.clock.resume();
      this.#stateVersion += 1;
      this.#event('SIMULATION_RESUMED', meta, {});
    });
  }

  assertInvariants(): void {
    assertSystemInvariants(this.snapshot());
  }

  async #execute<T>(
    meta: CommandMeta,
    commandType: string,
    action: () => T | Promise<T>,
  ): Promise<T> {
    let originalOutcome: 'ACCEPTED' | 'REJECTED' | undefined;
    try {
      const result = await this.#queueMutex.runExclusive(
        `coordinator:${meta.commandId}`,
        async () => {
          const cached = this.#commandResults.get(meta.commandId);
          if (cached) {
            if (cached.ok) return cached.value as T;
            throw cached.error;
          }
          try {
            if (
              meta.expectedStateVersion !== undefined &&
              meta.expectedStateVersion !== this.#stateVersion
            ) {
              throw new DomainError(
                'STATE_VERSION_CONFLICT',
                `Expected state version ${meta.expectedStateVersion}, actual ${this.#stateVersion}.`,
              );
            }
            const value = await action();
            this.assertInvariants();
            this.#commandResults.set(meta.commandId, { ok: true, value });
            originalOutcome = 'ACCEPTED';
            return value;
          } catch (error) {
            this.#commandResults.set(meta.commandId, { ok: false, error });
            originalOutcome = 'REJECTED';
            throw error;
          }
        },
      );
      if (originalOutcome === 'ACCEPTED') {
        this.#event('AUDIT_ENTRY_CREATED', meta, {
          commandType,
          outcome: 'ACCEPTED',
        });
      }
      return result;
    } catch (error) {
      if (originalOutcome === 'REJECTED') {
        this.#event('AUDIT_ENTRY_CREATED', meta, {
          commandType,
          outcome: 'REJECTED',
          reasonCode:
            error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
        });
      }
      throw error;
    }
  }

  #newJob(
    submission: JobSubmission,
    sequence: number,
    nowMs: number,
  ): PrintJob {
    if (this.#jobs.has(submission.id)) {
      throw new DomainError('INVARIANT_VIOLATION', 'Job IDs must be unique.');
    }
    const queuedAtMs = nowMs + submission.input.arrivalDelayMs;
    let job: PrintJob = {
      id: submission.id,
      ownerId: submission.ownerId,
      documentName: submission.input.documentName,
      pages: submission.input.pages,
      pagesCompleted: 0,
      basePriority: submission.input.basePriority,
      colorMode: submission.input.colorMode,
      duplex: submission.input.duplex,
      status: queuedAtMs > nowMs ? 'QUEUED' : 'READY',
      submittedAtMs: nowMs,
      queuedAtMs,
      retryCount: 0,
      sequence,
      version: 0,
    };
    assertJobInvariants(job);
    if (job.status === 'READY' && !this.#hasCompatiblePrinter(job)) {
      job = transitionJob(job, 'BLOCKED');
    }
    return job;
  }

  #reconcileCompatibility(meta: CommandMeta): void {
    for (const job of this.#jobs.values()) {
      if (job.status !== 'READY' && job.status !== 'BLOCKED') continue;
      const compatible = this.#hasCompatiblePrinter(job);
      if (job.status === 'READY' && !compatible) {
        const blocked = transitionJob(job, 'BLOCKED');
        this.#jobs.set(job.id, blocked);
        this.#event('JOB_UPDATED', meta, { jobId: job.id, status: 'BLOCKED' });
      } else if (job.status === 'BLOCKED' && compatible) {
        const ready = transitionJob(job, 'READY');
        this.#jobs.set(job.id, ready);
        this.#event('JOB_UPDATED', meta, { jobId: job.id, status: 'READY' });
      }
    }
  }

  #hasCompatiblePrinter(job: PrintJob): boolean {
    return [...this.#printers.values()].some(
      (printer) =>
        printer.status !== 'OFFLINE' &&
        printer.status !== 'ERROR' &&
        (job.colorMode === 'MONO' || printer.supportsColor) &&
        (!job.duplex || printer.supportsDuplex),
    );
  }

  #jobFor(jobId: string): PrintJob {
    const job = this.#jobs.get(jobId);
    if (!job) throw new RangeError(`Unknown job ${jobId}.`);
    return job;
  }

  #printerFor(printerId: string): PrinterState {
    const printer = this.#printers.get(printerId);
    if (!printer) throw new RangeError(`Unknown printer ${printerId}.`);
    return printer;
  }

  #mutexFor(printerId: string): BinaryLeaseMutex {
    const mutex = this.#printerMutexes.get(printerId);
    if (!mutex) throw new RangeError(`Unknown printer ${printerId}.`);
    return mutex;
  }

  #event(
    type: string,
    meta: CommandMeta,
    data: Readonly<Record<string, unknown>>,
  ): void {
    this.#events.push({
      type,
      stateVersion: this.#stateVersion,
      simulationTimeMs: this.clock.state.simulationTimeMs,
      ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
      data,
    });
  }
}

export function assertSystemInvariants(state: CoordinatorSnapshot): void {
  const assignments = state.printers.flatMap((printer) =>
    printer.activeJobId ? [printer.activeJobId] : [],
  );
  if (new Set(assignments).size !== assignments.length) {
    failInvariant('A job is assigned to more than one printer.');
  }
  const activeIds = new Set(state.activeBufferJobIds);
  if (activeIds.size !== state.activeBufferJobIds.length) {
    failInvariant('The active buffer contains duplicate jobs.');
  }
  if (activeIds.size > state.queueCapacity) {
    failInvariant('The active buffer exceeds capacity.');
  }
  for (const job of state.jobs) {
    assertJobInvariants(job);
    if (isTerminalStatus(job.status) === activeIds.has(job.id)) {
      failInvariant('Terminal and active-buffer membership disagree.');
    }
    if (job.status === 'PRINTING' || job.status === 'PAUSED') {
      const owners = state.printers.filter(
        (printer) => printer.activeJobId === job.id,
      );
      const owner = owners[0];
      if (
        owners.length !== 1 ||
        owner?.id !== job.assignedPrinterId ||
        owner?.mutex.locked !== true
      ) {
        failInvariant('Printing job ownership is inconsistent.');
      }
    }
  }
  for (const printer of state.printers) {
    const active = printer.activeJobId !== undefined && printer.mutex.locked;
    if (
      (printer.status === 'PRINTING' && !active) ||
      (active &&
        printer.status !== 'PRINTING' &&
        printer.status !== 'JAMMED' &&
        printer.status !== 'ERROR')
    ) {
      failInvariant('Printer state and mutex ownership disagree.');
    }
  }
  const readyPrinters = state.printers.filter(
    (printer) => printer.status === 'READY',
  ).length;
  if (state.availablePrinterPermits !== readyPrinters) {
    failInvariant('Available-printer permits do not match ready printers.');
  }
}

function bestPrinterFor(
  job: PrintJob,
  printers: readonly PrinterState[],
): PrinterState | undefined {
  return printers
    .filter(
      (printer) =>
        (job.colorMode === 'MONO' || printer.supportsColor) &&
        (!job.duplex || printer.supportsDuplex),
    )
    .sort(
      (left, right) =>
        ((job.pages - job.pagesCompleted) * 60_000) / left.pagesPerMinute -
          ((job.pages - job.pagesCompleted) * 60_000) / right.pagesPerMinute ||
        left.id.localeCompare(right.id),
    )[0];
}

function assertPrinter(printer: PrinterState): void {
  if (!printer.id || !printer.name.trim()) {
    throw new TypeError('Printer identity and name are required.');
  }
  if (
    !Number.isFinite(printer.pagesPerMinute) ||
    printer.pagesPerMinute < 1 ||
    printer.pagesPerMinute > 600
  ) {
    throw new RangeError(
      'Printer speed must be from 1 to 600 pages per minute.',
    );
  }
  if (printer.status !== 'READY' && printer.status !== 'OFFLINE') {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'Coordinator printers must start ready or offline.',
    );
  }
  if (printer.activeJobId) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'Coordinator printers must start idle.',
    );
  }
}

function failInvariant(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function withoutAssignment(job: PrintJob): PrintJob {
  const copy = { ...job } as PrintJob & { assignedPrinterId?: string };
  delete copy.assignedPrinterId;
  return copy;
}
