import { createHash } from 'node:crypto';
import type { CreateBurstRequest } from '@printer/contracts';
import type { JobSubmission } from '../domain/index.js';

export function generateBurst(
  request: CreateBurstRequest,
  ownerId: string,
): { submissions: readonly JobSubmission[]; workloadHash: string } {
  const random = xorshift32(request.seed);
  let arrivalDelayMs = 0;
  const submissions = Array.from({ length: request.count }, (_, index) => {
    if (index > 0) {
      if (request.arrival.kind === 'UNIFORM_INTERVAL') {
        arrivalDelayMs += request.arrival.intervalMs;
      } else if (request.arrival.kind === 'POISSON') {
        arrivalDelayMs += Math.max(
          1,
          Math.round(-Math.log(1 - random()) * request.arrival.meanIntervalMs),
        );
      }
    }
    if (arrivalDelayMs > 3_600_000) {
      throw new RangeError('Generated arrival delay exceeds 3,600,000 ms.');
    }
    return {
      id: deterministicUuid(request.seed, index),
      ownerId,
      input: {
        documentName: `${request.namePrefix} ${index + 1}`,
        pages: sample(request.pages, random),
        basePriority: sample(request.priority, random),
        colorMode: random() < request.colorRatio ? 'COLOR' : 'MONO',
        duplex: random() < request.duplexRatio,
        arrivalDelayMs,
      },
    } satisfies JobSubmission;
  });
  return {
    submissions,
    workloadHash: createHash('sha256')
      .update(JSON.stringify(submissions))
      .digest('hex'),
  };
}

function sample(
  distribution: CreateBurstRequest['pages'] | CreateBurstRequest['priority'],
  random: () => number,
): number {
  if (distribution.kind === 'FIXED') return distribution.value;
  if (distribution.kind === 'UNIFORM') {
    return (
      distribution.min +
      Math.floor(random() * (distribution.max - distribution.min + 1))
    );
  }
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  const normal =
    Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  return Math.max(
    distribution.min,
    Math.min(
      distribution.max,
      Math.round(distribution.mean + normal * distribution.stdDev),
    ),
  );
}

function xorshift32(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function deterministicUuid(seed: number, index: number): string {
  const value = createHash('sha256')
    .update(`${seed}:${index}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  value[12] = '4';
  value[16] = '8';
  const hex = value.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
