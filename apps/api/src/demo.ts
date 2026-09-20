import { randomUUID } from 'node:crypto';
import {
  PrinterWorkerPool,
  QueueCoordinator,
  SimulationClock,
  throughputJobsPerMinute,
  type DomainEvent,
  type PrinterState,
} from './domain/index.js';

const clock = new SimulationClock();
const printers: PrinterState[] = ['A', 'B'].map((suffix) => ({
  id: `printer-${suffix}`,
  name: `Printer ${suffix}`,
  status: 'READY',
  pagesPerMinute: 60,
  supportsColor: true,
  supportsDuplex: true,
  version: 0,
}));
const coordinator = new QueueCoordinator(
  clock,
  {
    algorithm: 'FCFS',
    agingIntervalMs: 5_000,
    agingFactor: 2,
    priorityCap: 100,
  },
  printers,
  10,
);

const submissions = [3, 2, 4, 1].map((pages, index) => ({
  id: `job-${index + 1}`,
  ownerId: 'demo-user',
  input: {
    documentName: `Demo document ${index + 1}`,
    pages,
    basePriority: 50,
    colorMode: 'MONO' as const,
    duplex: false,
    arrivalDelayMs: 0,
  },
}));

await coordinator.submitBurst(
  { commandId: randomUUID(), expectedStateVersion: 0 },
  submissions,
  'ATOMIC',
);
await coordinator.cancelJob(
  {
    commandId: randomUUID(),
    expectedStateVersion: coordinator.snapshot().stateVersion,
  },
  'job-4',
);

const printEvents = (events: readonly DomainEvent[]) => {
  for (const event of events) {
    console.log(
      `${event.simulationTimeMs.toString().padStart(5)} ms  ${event.type}`,
      event.data,
    );
  }
};
const finalState = await new PrinterWorkerPool(coordinator).runUntilIdle({
  onEvents: printEvents,
});
const completed = finalState.jobs.filter((job) => job.status === 'COMPLETED');
const cancelled = finalState.jobs.filter((job) => job.status === 'CANCELLED');
const throughput = throughputJobsPerMinute(
  completed.length,
  clock.state.simulationTimeMs,
);

if (
  completed.length !== 3 ||
  cancelled.length !== 1 ||
  finalState.activeBufferJobIds.length !== 0 ||
  finalState.availablePrinterPermits !== 2
) {
  throw new Error('Week 3 demonstration ended with invalid state.');
}

console.log({
  completedJobs: completed.length,
  cancelledJobs: cancelled.length,
  elapsedSimulationMs: clock.state.simulationTimeMs,
  throughputJobsPerMinute: throughput,
  leakedLocks: finalState.printers.some((printer) => printer.mutex.locked),
});
