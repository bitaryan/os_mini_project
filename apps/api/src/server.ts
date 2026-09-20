import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pino } from 'pino';
import { z } from 'zod';
import { apiEnvSchema } from './env.js';
import { SimulationService } from './application/index.js';
import { AutomationDaemon } from './agents/index.js';
import { createApp } from './http/app.js';
import { PrismaSimulationRepository } from './persistence/index.js';
import { SocketGateway } from './realtime/index.js';

const result = apiEnvSchema.safeParse(process.env);
if (!result.success) {
  console.error(
    'Invalid API configuration:',
    [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(
      ', ',
    ),
  );
  process.exit(1);
}
const env = result.data;
const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'api', environment: env.NODE_ENV },
});
const { version } = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ),
  );
const repository = new PrismaSimulationRepository(env.DATABASE_URL);
const service = new SimulationService(repository, {
  queueCapacity: env.QUEUE_CAPACITY,
  algorithm: env.DEFAULT_ALGORITHM,
  agingIntervalMs: env.AGING_INTERVAL_MS,
  agingFactor: env.AGING_FACTOR,
  priorityCap: env.PRIORITY_CAP,
  workerLeaseMs: env.WORKER_LEASE_MS,
});
await service.initialize();
if (!(await service.isReady())) {
  logger.fatal('Database is unavailable or migrations are not applied');
  await service.close();
  process.exit(1);
}
const automation = new AutomationDaemon(
  service,
  env.SIMULATION_TICK_MS,
  env.WATCHDOG_STUCK_MS,
);
const agentStatuses = () => automation.statuses();
const app = createApp(logger, version, env.TRUST_PROXY, {
  service,
  webOrigin: env.WEB_ORIGIN,
  agentStatuses,
  enableFaultInjection: env.ENABLE_FAULT_INJECTION,
});
const server = createServer(app);
const socketGateway = new SocketGateway(
  server,
  service,
  repository,
  env.WEB_ORIGIN,
  agentStatuses,
);
automation.start();
socketGateway.start();
server.listen(env.PORT, () =>
  logger.info({ port: env.PORT, version }, 'Foundation API listening'),
);
server.on('error', (error: NodeJS.ErrnoException) => {
  logger.fatal({ code: error.code }, 'API listener failed');
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Stopping API');
    automation.stop();
    void socketGateway
      .close()
      .then(() => service.close())
      .then(
        () => {
          server.close((error) => (process.exitCode = error ? 1 : 0));
          setTimeout(() => {
            server.closeAllConnections();
          }, 5_000).unref();
        },
        (error: unknown) => {
          logger.error({ error }, 'Database shutdown failed');
          process.exitCode = 1;
          server.closeAllConnections();
        },
      );
  });
}
