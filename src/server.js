const Fastify = require('fastify');

const app = Fastify({ logger: true });

// Liveness probe
app.get('/livez', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Readiness probe
app.get('/readyz', async () => {
  return { status: 'ready' };
});

const start = async () => {
  const port = process.env.PORT || 3000;
  const host = '0.0.0.0';

  try {
    await app.listen({ port, host });
    app.log.info(`Notification Service listening on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();