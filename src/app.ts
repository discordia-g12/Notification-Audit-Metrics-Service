import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

const READYZ_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface BuildAppOptions {
  databaseUrl?: string;
}

function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  const databaseUrl =
    options.databaseUrl ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:password@127.0.0.1:5432/notification_db';

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: READYZ_TIMEOUT_MS,
    max: 5,
  });

  pool.on('error', (err) => app.log.error(err, 'Postgres pool error'));

  app.get('/livez', async () => {
    return { status: 'alive' };
  });

  app.get('/readyz', async (_request, reply) => {
    try {
      await withTimeout(pool.query('SELECT 1'), READYZ_TIMEOUT_MS);
      return { status: 'ready' };
    } catch (error) {
      reply.code(503).send({ status: 'not_ready', detail: (error as Error).message });
    }
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}

export default buildApp;
