import { describe, expect, test } from 'vitest';
import { SimulationClock } from '../../src/domain/index.js';

describe('simulation clock', () => {
  test('advances monotonically at the configured speed without timers', () => {
    const clock = new SimulationClock({ realTimeMs: 1_000 });
    expect(clock.tick(2_000)).toBe(1_000);
    expect(clock.setSpeed(2, 2_500).simulationTimeMs).toBe(1_500);
    expect(clock.advanceBy(250)).toBe(2_000);
    expect(clock.tick(2_000)).toBe(2_000);
  });

  test('freezes simulation and watchdog duration while paused', () => {
    const clock = new SimulationClock();
    clock.advanceBy(5_000);
    clock.pause();
    expect(clock.advanceBy(60_000)).toBe(5_000);
    clock.resume();
    expect(clock.advanceBy(1_000)).toBe(6_000);
  });

  test('retains fractional progress at quarter speed', () => {
    const clock = new SimulationClock({ speedMultiplier: 0.25 });
    expect(clock.advanceBy(1)).toBe(0);
    expect(clock.advanceBy(3)).toBe(1);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid time %s',
    (time) => {
      const clock = new SimulationClock();
      expect(() => clock.tick(time)).toThrow(RangeError);
    },
  );
});
