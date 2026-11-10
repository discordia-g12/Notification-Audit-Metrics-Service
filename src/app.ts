import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadStatusConfig } from './config/status';
import { createStatusMonitor, statusRoutes, type StatusSource } from './modules/status';
import {
  initAuditDatabase,
  auditRoutes,
  AuditConsumer,
  type checkServerModeratorAccess,
} from './modules/audit';
import { createDatabaseCheck } from './utils/db-check';

const READYZ_TIMEOUT_MS = 2000;

export interface BuildAppOptions {
  databaseUrl?: string;
  /** Variables de entorno para la config (default process.env). Los tests pasan las suyas. */
  env?: Record<string, string | undefined>;
  /** Reemplaza el monitor de estado real (tests). */
  statusMonitor?: StatusSource;
  logger?: boolean;
  /** Reemplaza el pool de Postgres (tests). */
  pool?: Pool;
  /** Deshabilita el consumidor de RabbitMQ (para tests). */
  disableAuditConsumer?: boolean;
  /** Reemplaza el AuditConsumer (tests). */
  auditConsumer?: { start(): void; stop(): Promise<void> };
  /** Reemplaza el check de permisos de moderación (tests). */
  checkModeratorAccess?: typeof checkServerModeratorAccess;
}

function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const env = options.env ?? process.env;
  const statusConfig = loadStatusConfig(env);

  const databaseUrl =
    options.databaseUrl ||
    env.DATABASE_URL ||
    'postgresql://postgres:password@127.0.0.1:5432/notification_db';

  const pool =
    options.pool ??
    new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: READYZ_TIMEOUT_MS,
      max: 5,
    });

  pool.on('error', (err) => app.log.error(err, 'Postgres pool error'));

  const readyzCheck = createDatabaseCheck(pool, READYZ_TIMEOUT_MS);

  app.get('/livez', async () => {
    return { status: 'alive' };
  });

  app.get('/readyz', async (_request, reply) => {
    try {
      await readyzCheck();
      return { status: 'ready' };
    } catch (error) {
      reply.code(503).send({ status: 'not_ready', detail: (error as Error).message });
    }
  });

  const statusMonitor =
    options.statusMonitor ??
    createStatusMonitor(
      statusConfig,
      createDatabaseCheck(pool, statusConfig.probeTimeoutMs),
      app.log.child({ module: 'status' }),
    );
  app.register(statusRoutes, { monitor: statusMonitor });

  app.register(auditRoutes, {
    pool,
    serverRolesUrl: env.SERVER_ROLES_URL,
    checkAccess: options.checkModeratorAccess,
  });

  const auditConsumer =
    options.auditConsumer ??
    (options.disableAuditConsumer
      ? null
      : new AuditConsumer({
          pool,
          url: env.RABBITMQ_URL,
          exchange: env.RABBITMQ_EXCHANGE,
          queue: env.RABBITMQ_QUEUE,
          logger: app.log.child({ module: 'audit' }),
        }));

  // Primera ronda al quedar lista la app, sin esperarla: no demora el listen.
  app.addHook('onReady', async () => {
    try {
      await initAuditDatabase(pool);
    } catch (err) {
      app.log.warn({ err }, 'Could not initialize audit database schema');
    }
    statusMonitor.start();
    auditConsumer?.start();
  });

  app.addHook('onClose', async () => {
    await auditConsumer?.stop();
    await statusMonitor.stop();
    await pool.end();
  });

  return app;
}

export default buildApp;
