import type { TimelineResource } from '@printer/contracts';
import type { PersistedEvent } from '../persistence/index.js';

type Kind = TimelineResource['intervals'][number]['kind'];
type OpenInterval = {
  kind: Kind;
  printerId: string;
  jobId?: string;
  startMs: number;
};

export function buildTimeline(
  events: readonly PersistedEvent[],
  printerIds: readonly string[],
  fromMs: number,
  toMs: number,
  filters: { printerId?: string; jobId?: string } = {},
): TimelineResource {
  const open = new Map<string, OpenInterval>();
  const closed: TimelineResource['intervals'] = [];
  const queueDepth: TimelineResource['queueDepth'] = [];
  let depth = 0;
  const key = (kind: Kind, printerId: string) => `${kind}:${printerId}`;
  const start = (interval: OpenInterval) =>
    open.set(key(interval.kind, interval.printerId), interval);
  const stop = (kind: Kind, printerId: string, endMs: number) => {
    const current = open.get(key(kind, printerId));
    if (!current) return;
    open.delete(key(kind, printerId));
    pushInterval(closed, current, endMs, fromMs, toMs);
  };

  for (const event of events) {
    const data = event.payload.data;
    const printerId =
      typeof data['printerId'] === 'string' ? data['printerId'] : undefined;
    const jobId = typeof data['jobId'] === 'string' ? data['jobId'] : undefined;
    if (event.type === 'JOB_SUBMITTED') depth += 1;
    if (['JOB_COMPLETED', 'JOB_CANCELLED', 'JOB_FAILED'].includes(event.type))
      depth = Math.max(0, depth - 1);
    if (
      event.simulationTimeMs >= fromMs &&
      [
        'JOB_SUBMITTED',
        'JOB_COMPLETED',
        'JOB_CANCELLED',
        'JOB_FAILED',
      ].includes(event.type)
    )
      queueDepth.push({ timeMs: event.simulationTimeMs, depth });
    if (!printerId) continue;
    if (event.type === 'JOB_DISPATCHED') {
      start({
        kind: 'EXECUTION',
        printerId,
        ...(jobId ? { jobId } : {}),
        startMs: event.simulationTimeMs,
      });
      start({
        kind: 'MUTEX',
        printerId,
        ...(jobId ? { jobId } : {}),
        startMs: event.simulationTimeMs,
      });
    } else if (event.type === 'PRINTER_JAMMED') {
      stop('EXECUTION', printerId, event.simulationTimeMs);
      start({
        kind: 'JAM',
        printerId,
        ...(jobId ? { jobId } : {}),
        startMs: event.simulationTimeMs,
      });
    } else if (event.type === 'PRINTER_RECOVERED') {
      stop('JAM', printerId, event.simulationTimeMs);
      if (jobId) {
        start({
          kind: 'EXECUTION',
          printerId,
          jobId,
          startMs: event.simulationTimeMs,
        });
      } else {
        stop('MUTEX', printerId, event.simulationTimeMs);
      }
    } else if (
      event.type === 'PRINTER_UPDATED' &&
      data['status'] === 'OFFLINE'
    ) {
      start({ kind: 'OFFLINE', printerId, startMs: event.simulationTimeMs });
    } else if (event.type === 'PRINTER_UPDATED' && data['status'] === 'READY') {
      stop('OFFLINE', printerId, event.simulationTimeMs);
    } else if (
      [
        'JOB_COMPLETED',
        'JOB_CANCELLED',
        'JOB_FAILED',
        'MUTEX_FORCE_RELEASED',
      ].includes(event.type)
    ) {
      stop('EXECUTION', printerId, event.simulationTimeMs);
      stop('MUTEX', printerId, event.simulationTimeMs);
    }
  }
  for (const interval of open.values())
    pushInterval(closed, interval, toMs, fromMs, toMs);
  const visiblePrinters = filters.printerId ? [filters.printerId] : printerIds;
  for (const printerId of visiblePrinters)
    addIdleIntervals(closed, printerId, fromMs, toMs);
  return {
    fromMs,
    toMs,
    intervals: closed
      .filter(
        (item) =>
          (!filters.printerId || item.printerId === filters.printerId) &&
          (!filters.jobId || item.jobId === filters.jobId),
      )
      .sort(
        (left, right) =>
          left.startMs - right.startMs || left.id.localeCompare(right.id),
      ),
    queueDepth: [
      { timeMs: fromMs, depth: depthAt(events, fromMs) },
      ...queueDepth,
    ],
  };
}

function pushInterval(
  intervals: TimelineResource['intervals'],
  value: OpenInterval,
  endMs: number,
  fromMs: number,
  toMs: number,
) {
  const startMs = Math.max(fromMs, value.startMs);
  const clippedEnd = Math.min(toMs, endMs);
  if (clippedEnd <= startMs) return;
  intervals.push({
    id: `${value.kind}:${value.printerId}:${value.jobId ?? '-'}:${startMs}`,
    ...value,
    startMs,
    endMs: clippedEnd,
  });
}

function addIdleIntervals(
  intervals: TimelineResource['intervals'],
  printerId: string,
  fromMs: number,
  toMs: number,
) {
  const occupied = intervals
    .filter((item) => item.printerId === printerId && item.kind !== 'MUTEX')
    .sort((left, right) => left.startMs - right.startMs);
  let cursor = fromMs;
  for (const item of occupied) {
    if (item.startMs > cursor)
      intervals.push({
        id: `IDLE:${printerId}:${cursor}`,
        kind: 'IDLE',
        printerId,
        startMs: cursor,
        endMs: item.startMs,
      });
    cursor = Math.max(cursor, item.endMs);
  }
  if (cursor < toMs)
    intervals.push({
      id: `IDLE:${printerId}:${cursor}`,
      kind: 'IDLE',
      printerId,
      startMs: cursor,
      endMs: toMs,
    });
}

function depthAt(events: readonly PersistedEvent[], atMs: number) {
  let depth = 0;
  for (const event of events) {
    if (event.simulationTimeMs >= atMs) break;
    if (event.type === 'JOB_SUBMITTED') depth += 1;
    if (['JOB_COMPLETED', 'JOB_CANCELLED', 'JOB_FAILED'].includes(event.type))
      depth = Math.max(0, depth - 1);
  }
  return depth;
}
