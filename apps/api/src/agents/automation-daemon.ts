import { randomUUID } from 'node:crypto';
import type { StateSnapshot } from '@printer/contracts';
import type { SimulationService } from '../application/index.js';

type AgentStatus = StateSnapshot['agents'][number];

export class AutomationDaemon {
  readonly #inFlight = new Set<string>();
  readonly #failures: number[] = [];
  readonly #unsubscribe: () => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #circuitOpenUntil = 0;
  #lastActionAt: string | undefined;

  constructor(
    readonly service: SimulationService,
    readonly tickMs = 250,
    readonly stuckThresholdMs = 15_000,
  ) {
    this.#unsubscribe = service.onCommit(({ simulationId, events }) => {
      if (
        this.#running &&
        events.some((event) => event.type === 'JOB_SUBMITTED')
      ) {
        queueMicrotask(() => void this.tickSimulation(simulationId));
      }
    });
  }

  start(): void {
    if (this.#timer) return;
    this.#running = true;
    this.#timer = setInterval(() => {
      for (const simulationId of this.service.loadedSimulationIds()) {
        void this.tickSimulation(simulationId);
      }
    }, this.tickMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#running = false;
    this.#unsubscribe();
  }

  status(): AgentStatus {
    return {
      name: 'automation-daemon',
      health: Date.now() < this.#circuitOpenUntil ? 'DEGRADED' : 'HEALTHY',
      circuit: Date.now() < this.#circuitOpenUntil ? 'OPEN' : 'CLOSED',
      ...(this.#lastActionAt ? { lastActionAt: this.#lastActionAt } : {}),
    };
  }

  statuses(): StateSnapshot['agents'] {
    const lastAction = this.#lastActionAt
      ? { lastActionAt: this.#lastActionAt }
      : {};
    return [
      this.status(),
      {
        name: 'watchdog-intercept',
        health: 'HEALTHY',
        circuit: 'CLOSED',
        ...lastAction,
      },
      {
        name: 'load-balancer',
        health: 'HEALTHY',
        circuit: 'CLOSED',
        ...lastAction,
      },
      {
        name: 'starvation-guard',
        health: 'HEALTHY',
        circuit: 'CLOSED',
        ...lastAction,
      },
      {
        name: 'metrics-evaluator',
        health: 'HEALTHY',
        circuit: 'CLOSED',
        ...lastAction,
      },
    ];
  }

  async tickSimulation(simulationId: string): Promise<void> {
    if (
      this.#inFlight.has(simulationId) ||
      Date.now() < this.#circuitOpenUntil
    ) {
      return;
    }
    this.#inFlight.add(simulationId);
    try {
      const current = await this.service.getCoordinator(simulationId);
      const currentSnapshot = current.snapshot();
      if (
        current.clock.state.paused ||
        !currentSnapshot.jobs.some(
          (job) =>
            job.status === 'QUEUED' ||
            job.status === 'READY' ||
            job.status === 'BLOCKED' ||
            job.status === 'PRINTING' ||
            job.status === 'PAUSED',
        )
      ) {
        return;
      }
      const result = await this.service.mutate(
        simulationId,
        {
          actor: { id: 'automation-daemon', role: 'ADMIN' },
          actorKind: 'AGENT',
          correlationId: randomUUID(),
          commandType: 'SIMULATION_TICK',
          routeKey: 'agent:simulation-tick',
          requestBody: { elapsedRealMs: this.tickMs },
          statusCode: 200,
        },
        async (coordinator) => {
          const recoveredPrinterIds: string[] = [];
          coordinator.clock.advanceBy(this.tickMs);
          await coordinator.activateArrivals({ commandId: randomUUID() });
          const snapshot = coordinator.snapshot();
          for (const printer of snapshot.printers) {
            if (printer.status !== 'PRINTING' || !printer.activeJobId) continue;
            const job = snapshot.jobs.find(
              (candidate) => candidate.id === printer.activeJobId,
            );
            const pageDurationMs = Math.ceil(60_000 / printer.pagesPerMinute);
            if (!job || job.lastProgressAtMs === undefined) continue;
            const stalled = this.service.isPrinterStalled(
              simulationId,
              printer.id,
            );
            const elapsed =
              coordinator.clock.state.simulationTimeMs - job.lastProgressAtMs;
            if (stalled) {
              if (
                elapsed >= this.stuckThresholdMs * 2 &&
                printer.mutex.leaseId &&
                printer.mutex.expiresAtMs !== undefined &&
                coordinator.clock.state.simulationTimeMs >=
                  printer.mutex.expiresAtMs
              ) {
                await coordinator.recoverStalledJob(
                  { commandId: randomUUID() },
                  printer.id,
                );
                recoveredPrinterIds.push(printer.id);
              }
              continue;
            }
            if (elapsed < pageDurationMs || !printer.mutex.leaseId) {
              continue;
            }
            await coordinator.advancePage(
              { commandId: randomUUID() },
              printer.id,
              printer.mutex.leaseId,
              printer.mutex.fenceToken,
            );
          }
          while (await coordinator.dispatch({ commandId: randomUUID() })) {
            // The coordinator serializes and deterministically balances each slot.
          }
          return {
            stateVersion: coordinator.snapshot().stateVersion,
            recoveredPrinterIds,
          };
        },
      );
      for (const printerId of result.value.recoveredPrinterIds) {
        this.service.setPrinterStalled(simulationId, printerId, false);
      }
      this.#lastActionAt = new Date().toISOString();
      this.#failures.length = 0;
    } catch {
      const now = Date.now();
      this.#failures.push(now);
      while (this.#failures[0] && this.#failures[0] < now - 10_000) {
        this.#failures.shift();
      }
      if (this.#failures.length >= 3) this.#circuitOpenUntil = now + 5_000;
    } finally {
      this.#inFlight.delete(simulationId);
    }
  }
}
