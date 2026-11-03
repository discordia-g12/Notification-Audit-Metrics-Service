import { test } from 'node:test';
import assert from 'node:assert';
import { aggregateStatus, StatusMonitor } from '../src/modules/status/monitor';
import { allOk, DOWN, fakeMonitor, OK } from './status-helpers';

test('monitor: antes de la primera ronda todo es unknown y checkedAt null', () => {
  const { monitor } = fakeMonitor(allOk());
  const snapshot = monitor.snapshot();
  assert.strictEqual(snapshot.status, 'unknown');
  assert.strictEqual(snapshot.checkedAt, null);
  assert.ok(snapshot.services.every((s) => s.status === 'unknown' && s.since === null));
});

test('monitor: 2xx → operational, error → degraded, con latencia y checkedAt', async () => {
  const results = allOk();
  results.set('chat', DOWN);
  const { monitor, clock } = fakeMonitor(results);
  await monitor.poll();

  const snapshot = monitor.snapshot();
  assert.strictEqual(snapshot.status, 'degraded');
  assert.deepStrictEqual(snapshot.checkedAt, new Date(clock.ms));
  const chat = snapshot.services.find((s) => s.id === 'chat');
  assert.strictEqual(chat?.status, 'degraded');
  assert.strictEqual(chat?.httpStatus, 503);
  assert.strictEqual(chat?.error, 'http_5xx');
  assert.strictEqual(typeof chat?.latencyMs, 'number');
  const auth = snapshot.services.find((s) => s.id === 'auth');
  assert.strictEqual(auth?.status, 'operational');
  assert.strictEqual(auth?.error, null);
});

test('monitor: una sonda que tira una excepción queda degraded con código saneado', async () => {
  const results = allOk();
  results.set('voice', Object.assign(new Error('connect ECONNREFUSED 10.0.1.20:3000'), { code: 'ECONNREFUSED' }));
  const { monitor } = fakeMonitor(results);
  await monitor.poll();

  const voice = monitor.snapshot().services.find((s) => s.id === 'voice');
  assert.deepStrictEqual(
    { status: voice?.status, httpStatus: voice?.httpStatus, error: voice?.error },
    { status: 'degraded', httpStatus: null, error: 'connection_refused' },
  );
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('10.0.1.20'));
});

test('monitor: sondas no configuradas quedan unknown', async () => {
  const { monitor } = fakeMonitor(new Map([['notification', OK]]));
  await monitor.poll();
  const snapshot = monitor.snapshot();
  assert.strictEqual(snapshot.status, 'unknown');
  assert.ok(snapshot.checkedAt);
  const gateway = snapshot.services.find((s) => s.id === 'gateway');
  assert.deepStrictEqual(
    { status: gateway?.status, checkedAt: gateway?.checkedAt, since: gateway?.since },
    { status: 'unknown', checkedAt: null, since: null },
  );
});

test('monitor: since cambia solo en transiciones', async () => {
  const results = allOk();
  const { monitor, clock, logs } = fakeMonitor(results);
  const sinceOf = () => monitor.snapshot().services.find((s) => s.id === 'auth')?.since?.getTime();

  await monitor.poll();
  const firstSince = sinceOf();
  assert.ok(firstSince);

  clock.ms += 15000;
  await monitor.poll();
  assert.strictEqual(sinceOf(), firstSince, 'sigue operational: since no cambia');

  clock.ms += 15000;
  results.set('auth', DOWN);
  await monitor.poll();
  const degradedSince = sinceOf();
  assert.ok(degradedSince && degradedSince > firstSince, 'operational → degraded: since nuevo');

  clock.ms += 15000;
  results.set('auth', { httpStatus: null, error: 'timeout' });
  await monitor.poll();
  assert.strictEqual(sinceOf(), degradedSince, 'cambia el error pero no el estado: since igual');
  assert.strictEqual(monitor.snapshot().services.find((s) => s.id === 'auth')?.error, 'timeout');

  clock.ms += 15000;
  results.set('auth', OK);
  await monitor.poll();
  assert.ok((sinceOf() as number) > degradedSince, 'vuelve a operational: since nuevo');

  const authLogs = logs.filter((l) => (l.fields as { service: string }).service === 'auth');
  assert.deepStrictEqual(
    authLogs.map((l) => l.level),
    ['info', 'warn', 'info'],
  );
});

test('monitor: poll no solapa rondas', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const monitor = new StatusMonitor({
    services: [
      {
        id: 'x',
        name: 'X',
        probe: () => {
          calls += 1;
          return new Promise((resolve) => {
            release = () => resolve({ httpStatus: 200, error: null });
          });
        },
      },
    ],
    intervalMs: 1000,
  });
  const first = monitor.poll();
  const second = monitor.poll();
  assert.strictEqual(first, second);
  release();
  await first;
  assert.strictEqual(calls, 1);
  assert.strictEqual(monitor.snapshot().status, 'operational');
});

test('monitor: start agenda una vez y dispara la primera ronda; stop la espera y limpia el timer', async () => {
  const { monitor, timers } = fakeMonitor(allOk());
  monitor.start();
  monitor.start();
  assert.deepStrictEqual(timers(), { scheduled: 1, cleared: 0 });
  await monitor.stop();
  assert.deepStrictEqual(timers(), { scheduled: 1, cleared: 1 });
  assert.strictEqual(monitor.snapshot().status, 'operational');
  await monitor.stop();
  assert.deepStrictEqual(timers(), { scheduled: 1, cleared: 1 });
});

test('monitor: timers reales por defecto, con unref', async () => {
  const monitor = new StatusMonitor({
    services: [{ id: 'x', name: 'X', probe: async () => ({ httpStatus: 200, error: null }) }],
    intervalMs: 60_000,
  });
  monitor.start();
  await monitor.stop();
  assert.strictEqual(monitor.snapshot().status, 'operational');
});

test('aggregateStatus', () => {
  assert.strictEqual(aggregateStatus(['operational', 'operational']), 'operational');
  assert.strictEqual(aggregateStatus(['operational', 'unknown']), 'unknown');
  assert.strictEqual(aggregateStatus(['unknown', 'degraded', 'operational']), 'degraded');
});
