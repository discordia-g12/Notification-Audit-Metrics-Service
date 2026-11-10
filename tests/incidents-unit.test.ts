import { test } from 'node:test';
import assert from 'node:assert';
import { ActiveIncidentsCache } from '../src/modules/incidents/active-cache';
import type { Incident } from '../src/modules/incidents/types';
import { toAdminIncident, toPublicIncident } from '../src/modules/incidents/views';
import { aggregatePlatformStatus, combineServiceStatus, combineStatus } from '../src/modules/status/combine';
import { allOk, DOWN, fakeMonitor } from './status-helpers';

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'degraded',
    status: 'active',
    title: 'Demoras',
    description: 'Algo anda lento',
    affectedServices: ['chat'],
    createdBy: 'auth0|staff',
    createdAt: new Date('2026-11-10T12:00:00.000Z'),
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    ...overrides,
  };
}

// --- combinación de estados ---

test('combineServiceStatus: mantenimiento > degradación > sonda', () => {
  assert.strictEqual(combineServiceStatus('operational', 'chat', []), 'operational');
  assert.strictEqual(combineServiceStatus('unknown', 'chat', []), 'unknown');
  assert.strictEqual(combineServiceStatus('degraded', 'chat', []), 'degraded');
  assert.strictEqual(combineServiceStatus('operational', 'chat', [incident()]), 'degraded');
  assert.strictEqual(combineServiceStatus('operational', 'voice', [incident()]), 'operational');
  assert.strictEqual(
    combineServiceStatus('degraded', 'chat', [incident(), incident({ kind: 'maintenance' })]),
    'maintenance',
  );
});

test('aggregatePlatformStatus: degraded > maintenance > unknown > operational', () => {
  assert.strictEqual(aggregatePlatformStatus(['operational', 'operational']), 'operational');
  assert.strictEqual(aggregatePlatformStatus(['operational', 'unknown']), 'unknown');
  assert.strictEqual(aggregatePlatformStatus(['unknown', 'maintenance']), 'maintenance');
  assert.strictEqual(aggregatePlatformStatus(['maintenance', 'degraded']), 'degraded');
  assert.strictEqual(aggregatePlatformStatus([]), 'operational');
});

test('combineStatus: sobre el snapshot real del monitor', async () => {
  const results = allOk();
  results.set('payments', DOWN);
  const { monitor } = fakeMonitor(results);
  await monitor.poll();
  const combined = combineStatus(monitor.snapshot(), [incident({ kind: 'maintenance', affectedServices: ['payments'] })]);
  assert.strictEqual(combined.status, 'maintenance');
  assert.strictEqual(combined.services.find((s) => s.id === 'payments')?.status, 'maintenance');
  assert.strictEqual(combined.services.length, 7);
});

// --- vistas ---

test('vistas: la pública no tiene autor; la de staff sí, con fechas ISO', () => {
  const resolved = incident({
    status: 'resolved',
    resolvedBy: 'auth0|other',
    resolvedAt: new Date('2026-11-10T13:00:00.000Z'),
    resolutionNote: 'ok',
  });
  assert.deepStrictEqual(toPublicIncident(resolved), {
    id: resolved.id,
    kind: 'degraded',
    title: 'Demoras',
    description: 'Algo anda lento',
    affectedServices: ['chat'],
    startedAt: '2026-11-10T12:00:00.000Z',
  });
  const admin = toAdminIncident(resolved);
  assert.strictEqual(admin.resolvedAt, '2026-11-10T13:00:00.000Z');
  assert.strictEqual(admin.createdBy, 'auth0|staff');
  assert.strictEqual(toAdminIncident(incident()).resolvedAt, null);
});

// --- caché de activos ---

function cacheWith(load: () => Promise<Incident[]>) {
  const clock = { ms: 0 };
  const warnings: object[] = [];
  const cache = new ActiveIncidentsCache({
    load,
    ttlMs: 5000,
    now: () => clock.ms,
    logger: { warn: (fields) => warnings.push(fields) },
  });
  return { cache, clock, warnings };
}

test('cache: dentro del TTL no vuelve a la base; vencido sí', async () => {
  let calls = 0;
  const { cache, clock } = cacheWith(async () => {
    calls += 1;
    return [incident()];
  });
  assert.strictEqual((await cache.get()).length, 1);
  clock.ms = 4999;
  await cache.get();
  assert.strictEqual(calls, 1);
  clock.ms = 5000;
  await cache.get();
  assert.strictEqual(calls, 2);
});

test('cache: pedidos simultáneos comparten una sola carga', async () => {
  let calls = 0;
  const { cache } = cacheWith(async () => {
    calls += 1;
    return [];
  });
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.strictEqual(calls, 1);
});

test('cache: invalidate fuerza la recarga, y gana sobre una carga en curso', async () => {
  let release: (value: Incident[]) => void = () => undefined;
  const loads: Array<Promise<Incident[]>> = [];
  const { cache } = cacheWith(() => {
    const p = new Promise<Incident[]>((resolve) => {
      release = resolve;
    });
    loads.push(p);
    return p;
  });
  const stale = cache.get();
  const releaseStale = release;
  cache.invalidate();
  const fresh = cache.get();
  assert.strictEqual(loads.length, 2);
  release([incident({ title: 'nuevo' })]);
  releaseStale([]);
  assert.deepStrictEqual(await stale, []);
  assert.strictEqual((await fresh)[0].title, 'nuevo');
  // El valor guardado es el de la carga posterior a la invalidación.
  assert.strictEqual((await cache.get())[0].title, 'nuevo');
  assert.strictEqual(loads.length, 2);
});

test('cache: si la base falla sirve el último valor y loguea solo el código', async () => {
  let fail = false;
  const { cache, clock, warnings } = cacheWith(async () => {
    if (fail) throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    return [incident()];
  });
  assert.strictEqual((await cache.get()).length, 1);
  fail = true;
  clock.ms = 10_000;
  assert.strictEqual((await cache.get()).length, 1);
  assert.deepStrictEqual(warnings, [{ code: 'ECONNREFUSED' }]);
});

test('cache: falla sin haber cargado nunca → vacío; error sin code → null', async () => {
  const { cache, warnings } = cacheWith(async () => {
    throw 'texto';
  });
  assert.deepStrictEqual(await cache.get(), []);
  assert.deepStrictEqual(warnings, [{ code: null }]);
});
