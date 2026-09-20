import type { SpeedMultiplier } from '@printer/contracts';
import type { SimulationClockState } from './entities.js';

const speeds = new Set<SpeedMultiplier>([0.25, 0.5, 1, 2, 4]);

export class SimulationClock {
  #simulationTimeMs: number;
  #speedMultiplier: SpeedMultiplier;
  #paused: boolean;
  #lastRealTimeMs: number;
  #fractionalSimulationMs = 0;

  constructor({
    realTimeMs = 0,
    simulationTimeMs = 0,
    speedMultiplier = 1,
    paused = false,
  }: {
    realTimeMs?: number;
    simulationTimeMs?: number;
    speedMultiplier?: SpeedMultiplier;
    paused?: boolean;
  } = {}) {
    assertTime(realTimeMs);
    assertTime(simulationTimeMs);
    if (!speeds.has(speedMultiplier))
      throw new RangeError('Unsupported speed multiplier.');
    this.#lastRealTimeMs = realTimeMs;
    this.#simulationTimeMs = simulationTimeMs;
    this.#speedMultiplier = speedMultiplier;
    this.#paused = paused;
  }

  get state(): SimulationClockState {
    return {
      simulationTimeMs: this.#simulationTimeMs,
      speedMultiplier: this.#speedMultiplier,
      paused: this.#paused,
    };
  }

  tick(realTimeMs: number): number {
    assertTime(realTimeMs);
    if (realTimeMs <= this.#lastRealTimeMs) return this.#simulationTimeMs;

    const elapsedRealMs = realTimeMs - this.#lastRealTimeMs;
    this.#lastRealTimeMs = realTimeMs;
    if (this.#paused) return this.#simulationTimeMs;

    const elapsedSimulationMs =
      elapsedRealMs * this.#speedMultiplier + this.#fractionalSimulationMs;
    const wholeMilliseconds = Math.floor(elapsedSimulationMs);
    this.#fractionalSimulationMs = elapsedSimulationMs - wholeMilliseconds;
    this.#simulationTimeMs += wholeMilliseconds;
    return this.#simulationTimeMs;
  }

  advanceBy(realElapsedMs: number): number {
    assertTime(realElapsedMs);
    return this.tick(this.#lastRealTimeMs + realElapsedMs);
  }

  advanceSimulationBy(elapsedSimulationMs: number): number {
    assertTime(elapsedSimulationMs);
    if (!this.#paused) this.#simulationTimeMs += elapsedSimulationMs;
    return this.#simulationTimeMs;
  }

  pause(realTimeMs = this.#lastRealTimeMs): SimulationClockState {
    this.tick(realTimeMs);
    this.#paused = true;
    return this.state;
  }

  resume(realTimeMs = this.#lastRealTimeMs): SimulationClockState {
    assertTime(realTimeMs);
    if (!this.#paused) {
      this.tick(realTimeMs);
      return this.state;
    }
    if (realTimeMs > this.#lastRealTimeMs) this.#lastRealTimeMs = realTimeMs;
    this.#paused = false;
    return this.state;
  }

  setSpeed(
    speedMultiplier: SpeedMultiplier,
    realTimeMs = this.#lastRealTimeMs,
  ): SimulationClockState {
    if (!speeds.has(speedMultiplier))
      throw new RangeError('Unsupported speed multiplier.');
    this.tick(realTimeMs);
    this.#speedMultiplier = speedMultiplier;
    return this.state;
  }

  reset(paused = true): SimulationClockState {
    this.#simulationTimeMs = 0;
    this.#lastRealTimeMs = 0;
    this.#fractionalSimulationMs = 0;
    this.#paused = paused;
    return this.state;
  }
}

function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Clock values must be non-negative safe integers.');
  }
}
