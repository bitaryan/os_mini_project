import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { z } from 'zod';
import { apiEnvSchema } from './env.js';
import { createApp } from './http/app.js';

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
const app = createApp(logger, version, env.TRUST_PROXY);
const server = app.listen(env.PORT, () =>
  logger.info({ port: env.PORT, version }, 'Foundation API listening'),
);
server.on('error', (error: NodeJS.ErrnoException) => {
  logger.fatal({ code: error.code }, 'API listener failed');
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Stopping API');
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
    setTimeout(() => {
      server.closeAllConnections();
    }, 5_000).unref();
  });
}
