import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { Logger } from 'pino';
import { uuidSchema } from '@printer/contracts';
import type {
  ApiErrorResponse,
  HealthLive,
  HealthReady,
} from '@printer/contracts';

export function createApp(
  logger: Logger,
  version: string,
  trustProxy: false | number = false,
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use((request, response, next) => {
    const requestId = randomUUID();
    const correlation = uuidSchema.safeParse(
      request.header('X-Correlation-Id'),
    );
    const correlationId = correlation.success ? correlation.data : randomUUID();
    const startedAt = performance.now();
    response.locals['meta'] = {
      requestId,
      correlationId,
      servedAt: new Date().toISOString(),
    };
    response.setHeader('X-Correlation-Id', correlationId);
    response.on('finish', () =>
      logger.info(
        {
          requestId,
          correlationId,
          method: request.method,
          status: response.statusCode,
          durationMs: performance.now() - startedAt,
        },
        'HTTP request',
      ),
    );
    next();
  });
  app.use(helmet());
  app.use(
    '/health',
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_request, response) => {
        response
          .status(429)
          .json({
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many health checks. Try again shortly.',
              retryable: true,
            },
            meta: response.locals['meta'],
          } satisfies ApiErrorResponse);
      },
    }),
  );
  app.get('/health/live', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      status: 'alive',
      version,
      uptimeSeconds: process.uptime(),
    } satisfies HealthLive);
  });
  app.get('/health/ready', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(503).json({
      status: 'not_ready',
      version,
      components: {
        configuration: 'ready',
        database: 'not_implemented',
        migrations: 'not_implemented',
        coordinator: 'not_implemented',
        invariants: 'not_implemented',
      },
    } satisfies HealthReady);
  });
  app.use((_request, response) => {
    response
      .status(404)
      .json({
        error: {
          code: 'NOT_FOUND',
          message: 'This endpoint is not available.',
          retryable: false,
        },
        meta: response.locals['meta'],
      } satisfies ApiErrorResponse);
  });
  return app;
}
