import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadMetricsConfig } from './config/metrics';
import { loadStatusConfig } from './config/status';
import { MIGRATIONS } from './db/migrations';
import { runMigrations } from './db/migrate';
import {
  ACTIVE_INCIDENTS_TTL_MS,
  ActiveIncidentsCache,
  incidentRoutes,
  PgIncidentStore,
  type IncidentStore,
} from './modules/incidents';
import {
  METRICS_CACHE_MAX_ENTRIES,
  METRICS_CACHE_TTL_MS,
  METRICS_SOURCE_TIMEOUT_MS,
  MetricsCache,
  MetricsSources,
  metricsRoutes,
  type FetchFn,
} from './modules/metrics';
import { createStatusMonitor, statusRoutes, type StatusSource } from './modules/status';
import {
  initAuditDatabase,
  auditRoutes,
  AuditConsumer,
  type checkServerModeratorAccess,
} from './modules/audit';
import {
  InboxPublisher,
  NotificationConsumer,
  notificationRoutes,
  purgeOldNotifications,
  RETENTION_INTERVAL_MS,
} from './modules/notifications';
import { createDatabaseCheck } from './utils/db-check';

const READYZ_TIMEOUT_MS = 2000;

export interface BuildAppOptions {
  databaseUrl?: string;
  /** Variables de entorno para la config (default process.env). Los tests pasan las suyas. */
  env?: Record<string, string | undefined>;
  /** Reemplaza el monitor de estado real (tests). */
  statusMonitor?: StatusSource;
  /** Reemplaza el store de incidentes en Postgres (tests). */
  incidentStore?: IncidentStore;
  /** Aplica las migraciones pendientes antes de quedar lista (server.ts). Los tests migran por su cuenta. */
  migrate?: boolean;
  logger?: boolean;
  /** Reemplaza el pool de Postgres (tests). */
  pool?: Pool;
  /** Deshabilita el consumidor de RabbitMQ (para tests). */
  disableAuditConsumer?: boolean;
  /** Reemplaza el AuditConsumer (tests). */
  auditConsumer?: { start(): void; stop(): Promise<void> };
  /** Deshabilita el consumidor de chat.message.created (tests). */
  disableNotificationConsumer?: boolean;
  /** Reemplaza el NotificationConsumer (tests). */
  notificationConsumer?: { start(): void; stop(): Promise<void> };
  /** Reemplaza el fetch del aviso en vivo por el inbox de Chat (tests). */
  inboxFetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Reemplaza el check de permisos de moderación (tests). */
  checkModeratorAccess?: typeof checkServerModeratorAccess;
  /** Reemplaza el fetch de las consultas de métricas a Chat y Server-Roles (tests). */
  metricsFetch?: FetchFn;
  /** Timeout de cada consulta de métricas (tests; default METRICS_SOURCE_TIMEOUT_MS). */
  metricsTimeoutMs?: number;
}

function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const env = options.env ?? process.env;
  const statusConfig = loadStatusConfig(env);
  const metricsConfig = loadMetricsConfig(env);

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
  const incidentStore = options.incidentStore ?? new PgIncidentStore(pool);
  const activeIncidents = new ActiveIncidentsCache({
    load: () => incidentStore.listActive(),
    ttlMs: ACTIVE_INCIDENTS_TTL_MS,
    logger: app.log.child({ module: 'incidents' }),
  });

  app.register(statusRoutes, { monitor: statusMonitor, incidents: activeIncidents });
  app.register(incidentRoutes, { store: incidentStore, activeIncidents });
  app.register(metricsRoutes, {
    sources: new MetricsSources({
      ...metricsConfig,
      timeoutMs: options.metricsTimeoutMs ?? METRICS_SOURCE_TIMEOUT_MS,
      fetchFn: options.metricsFetch,
    }),
    cache: new MetricsCache({ ttlMs: METRICS_CACHE_TTL_MS, maxEntries: METRICS_CACHE_MAX_ENTRIES }),
    serverConfig: {
      chatEngineUrl: metricsConfig.chatEngineUrl,
      coreServiceUrl: options.env?.CORE_SERVICE_URL
        ? metricsConfig.coreServiceUrl
        : (env.SERVER_ROLES_URL ?? metricsConfig.coreServiceUrl),
      timeoutMs: options.metricsTimeoutMs ?? METRICS_SOURCE_TIMEOUT_MS,
      fetchFn: options.metricsFetch,
    },
    serverCacheOptions: { ttlMs: METRICS_CACHE_TTL_MS, maxEntries: METRICS_CACHE_MAX_ENTRIES },
  });

  // Antes que el monitor: si una migración falla, ready() rechaza, el listen no ocurre y el contenedor no
  // queda healthy (el deploy vuelve a la imagen anterior).
  if (options.migrate) {
    app.addHook('onReady', async () => {
      await runMigrations(pool, MIGRATIONS, app.log.child({ module: 'migrations' }));
    });
  }

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

  app.register(notificationRoutes, { pool });

  const inbox = new InboxPublisher({
    chatEngineUrl: metricsConfig.chatEngineUrl,
    internalToken: env.INTERNAL_API_TOKEN,
    fetchFn: options.inboxFetch,
  });
  const notificationLog = app.log.child({ module: 'notifications' });
  const notificationConsumer =
    options.notificationConsumer ??
    (options.disableNotificationConsumer
      ? null
      : new NotificationConsumer({
          pool,
          url: env.RABBITMQ_URL,
          exchange: env.RABBITMQ_EXCHANGE,
          queue: env.RABBITMQ_MESSAGE_QUEUE,
          logger: notificationLog,
          deliver: (created) => {
            void inbox.publish(created).then((failed) => {
              if (failed > 0) notificationLog.warn({ failed }, 'notifications: no se pudo avisar por el inbox de Chat');
            });
          },
        }));

  // Retención de la bandeja: al arrancar y cada 6 h. Si falla, se reintenta en la próxima vuelta.
  const purge = () =>
    purgeOldNotifications(pool)
      .then((deleted) => deleted > 0 && notificationLog.info({ deleted }, 'notifications: avisos viejos borrados'))
      .catch((err) => notificationLog.warn({ err }, 'notifications: no se pudieron borrar los avisos viejos'));
  let purgeTimer: NodeJS.Timeout | null = null;

  // Primera ronda al quedar lista la app, sin esperarla: no demora el listen.
  app.addHook('onReady', async () => {
    try {
      await initAuditDatabase(pool);
    } catch (err) {
      app.log.warn({ err }, 'Could not initialize audit database schema');
    }
    statusMonitor.start();
    auditConsumer?.start();
    notificationConsumer?.start();
    if (notificationConsumer) {
      void purge();
      purgeTimer = setInterval(() => void purge(), RETENTION_INTERVAL_MS);
      purgeTimer.unref();
    }
  });

  app.addHook('onClose', async () => {
    if (purgeTimer) clearInterval(purgeTimer);
    await notificationConsumer?.stop();
    await auditConsumer?.stop();
    await statusMonitor.stop();
    await pool.end();
  });

  return app;
}

export default buildApp;
