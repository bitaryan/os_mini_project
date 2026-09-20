import { randomUUID } from 'node:crypto';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { Logger } from 'pino';
import { uuidSchema } from '@printer/contracts';
import type {
  ApiErrorResponse,
  ErrorCode,
  HealthLive,
  HealthReady,
  StateSnapshot,
} from '@printer/contracts';
import { ZodError } from 'zod';
import type { SimulationService } from '../application/index.js';
import { DomainError } from '../domain/index.js';
import { createApiRouter } from './api-router.js';
import { HttpError } from './http-error.js';

export interface AppRuntime {
  readonly service?: SimulationService;
  readonly webOrigin?: string;
  readonly agentStatuses?: () => StateSnapshot['agents'];
  readonly enableFaultInjection?: boolean;
}

export function createApp(
  logger: Logger,
  version: string,
  trustProxy: false | number = false,
  runtime: AppRuntime = {},
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
  const webOrigin = runtime.webOrigin;
  if (webOrigin) {
    app.use((request, response, next) => {
      if (request.header('Origin') === webOrigin) {
        response.setHeader('Access-Control-Allow-Origin', webOrigin);
        response.setHeader('Vary', 'Origin');
        response.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Idempotency-Key, If-Match, X-Correlation-Id, X-User-Id, X-User-Role',
        );
        response.setHeader(
          'Access-Control-Allow-Methods',
          'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        );
        response.setHeader(
          'Access-Control-Expose-Headers',
          'ETag, Idempotency-Replayed, X-Correlation-Id',
        );
        if (request.method === 'OPTIONS') {
          response.status(204).end();
          return;
        }
      }
      next();
    });
  }
  app.use((request, _response, next) => {
    const mayHaveBody = ['POST', 'PUT', 'PATCH'].includes(request.method);
    const hasBody = request.header('Content-Length') !== '0';
    if (mayHaveBody && hasBody && !request.is('application/json')) {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Requests with a body must use application/json.',
      );
    }
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(
    '/health',
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_request, response) => {
        response.status(429).json({
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
  app.get('/health/ready', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const ready = runtime.service ? await runtime.service.isReady() : false;
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      version,
      components: {
        configuration: 'ready',
        scheduler: 'ready',
        database: runtime.service
          ? ready
            ? 'ready'
            : 'unavailable'
          : 'not_implemented',
        migrations: runtime.service
          ? ready
            ? 'ready'
            : 'unavailable'
          : 'not_implemented',
        coordinator: runtime.service ? 'ready' : 'not_implemented',
        invariants: runtime.service ? 'ready' : 'not_implemented',
      },
    } satisfies HealthReady);
  });
  if (runtime.service)
    app.use(
      '/api/v1',
      createApiRouter(
        runtime.service,
        runtime.agentStatuses,
        runtime.enableFaultInjection,
      ),
    );
  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'This endpoint is not available.',
        retryable: false,
      },
      meta: response.locals['meta'],
    } satisfies ApiErrorResponse);
  });
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      void _next;
      const mapped = mapError(error);
      response.status(mapped.status).json({
        error: {
          code: mapped.code,
          message: mapped.message,
          retryable: mapped.retryable,
          ...(mapped.fieldErrors ? { fieldErrors: mapped.fieldErrors } : {}),
          ...(mapped.details ? { details: mapped.details } : {}),
        },
        meta: response.locals['meta'],
      } satisfies ApiErrorResponse);
    },
  );
  return app;
}

function mapError(error: unknown): {
  status: number;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  fieldErrors?: Record<string, string[]>;
  details?: Record<string, unknown>;
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: { ...error.details } } : {}),
    };
  }
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const field = issue.path.join('.') || 'request';
      (fieldErrors[field] ??= []).push(issue.message);
    }
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid.',
      retryable: false,
      fieldErrors,
    };
  }
  if (error instanceof DomainError) {
    const status =
      error.code === 'PERSISTENCE_UNAVAILABLE' ||
      error.code === 'INVARIANT_VIOLATION'
        ? 503
        : 409;
    return {
      status,
      code: error.code,
      message: error.message,
      retryable:
        error.code === 'STATE_VERSION_CONFLICT' ||
        error.code === 'RESOURCE_BUSY' ||
        error.code === 'PERSISTENCE_UNAVAILABLE',
    };
  }
  if (error instanceof RangeError && error.message.startsWith('Unknown ')) {
    return {
      status: 404,
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      retryable: false,
    };
  }
  if (error instanceof SyntaxError || error instanceof RangeError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: error.message,
      retryable: false,
    };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 413
  ) {
    return {
      status: 413,
      code: 'VALIDATION_ERROR',
      message: 'The request body exceeds the 64kb limit.',
      retryable: false,
    };
  }
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'The request could not be completed.',
    retryable: false,
  };
}
