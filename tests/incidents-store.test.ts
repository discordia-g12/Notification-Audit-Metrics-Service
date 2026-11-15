import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert';
import { PgIncidentStore } from '../src/modules/incidents/store';
import type { NewIncident } from '../src/modules/incidents/types';
import { createMigratedSchema } from './db-helpers';

type Db = Awaited<ReturnType<typeof createMigratedSchema>>;
let db: Db;
let store: PgIncidentStore;

const NEW: NewIncident = {
  kind: 'degraded',
  title: 'Demoras en la voz',
  description: 'Los canales de voz tardan en conectar.',
  affectedServices: ['voice'],
  createdBy: 'auth0|staff-1',
};

before(async () => {
  db = await createMigratedSchema();
  store = new PgIncidentStore(db.pool);
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE incidents, audit_logs');
});

after(async () => {
  await db.drop();
});

async function auditRows() {
  const { rows } = await db.pool.query(
    `SELECT actor_id, action, target_type, target_id, reason, metadata FROM audit_logs ORDER BY id`,
  );
  return rows;
}

test('create: persiste el incidente activo y deja su auditoría', async () => {
  const incident = await store.create({ ...NEW, affectedServices: ['chat', 'voice'] });
  assert.match(incident.id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(incident.status, 'active');
  assert.deepStrictEqual(incident.affectedServices, ['chat', 'voice']);
  assert.ok(incident.createdAt instanceof Date);
  assert.strictEqual(incident.resolvedAt, null);
  assert.strictEqual(incident.resolvedBy, null);

  assert.deepStrictEqual(await auditRows(), [
    {
      actor_id: 'auth0|staff-1',
      action: 'incident.created',
      target_type: 'incident',
      target_id: incident.id,
      reason: null,
      metadata: { kind: 'degraded', title: 'Demoras en la voz', affectedServices: ['chat', 'voice'] },
    },
  ]);
});

test('create: si la auditoría falla no queda el incidente (misma transacción)', async () => {
  await db.pool.query('ALTER TABLE audit_logs ADD CONSTRAINT no_writes CHECK (false) NOT VALID');
  try {
    await assert.rejects(store.create(NEW));
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM incidents');
    assert.strictEqual(rows[0].n, 0);
  } finally {
    await db.pool.query('ALTER TABLE audit_logs DROP CONSTRAINT no_writes');
  }
});

test('create: la base rechaza lo que la API no tendría que dejar pasar', async () => {
  await assert.rejects(store.create({ ...NEW, kind: 'outage' as never }));
  await assert.rejects(store.create({ ...NEW, affectedServices: [] }));
  await assert.rejects(store.create({ ...NEW, title: '  ' }));
});

test('resolve: cierra, registra quién y por qué, y una segunda vez da already_resolved', async () => {
  const incident = await store.create(NEW);
  const result = await store.resolve(incident.id, { resolvedBy: 'auth0|staff-2', note: 'Se reinició LiveKit' });
  assert.strictEqual(result.outcome, 'resolved');
  assert.ok(result.outcome === 'resolved');
  assert.strictEqual(result.incident.status, 'resolved');
  assert.strictEqual(result.incident.resolvedBy, 'auth0|staff-2');
  assert.strictEqual(result.incident.resolutionNote, 'Se reinició LiveKit');
  assert.ok(result.incident.resolvedAt instanceof Date);

  const again = await store.resolve(incident.id, { resolvedBy: 'auth0|staff-3', note: null });
  assert.strictEqual(again.outcome, 'already_resolved');
  assert.ok(again.outcome === 'already_resolved');
  assert.strictEqual(again.incident.resolvedBy, 'auth0|staff-2');

  const audit = await auditRows();
  assert.strictEqual(audit.length, 2);
  assert.deepStrictEqual(audit[1], {
    actor_id: 'auth0|staff-2',
    action: 'incident.resolved',
    target_type: 'incident',
    target_id: incident.id,
    reason: 'Se reinició LiveKit',
    metadata: { kind: 'degraded', title: 'Demoras en la voz' },
  });
});

test('resolve: id inexistente → not_found', async () => {
  const result = await store.resolve('00000000-0000-4000-8000-000000000000', { resolvedBy: 'x', note: null });
  assert.deepStrictEqual(result, { outcome: 'not_found' });
});

test('resolve: dos cierres simultáneos, uno solo gana', async () => {
  const incident = await store.create(NEW);
  const results = await Promise.all([
    store.resolve(incident.id, { resolvedBy: 'a', note: null }),
    store.resolve(incident.id, { resolvedBy: 'b', note: null }),
  ]);
  assert.deepStrictEqual(results.map((r) => r.outcome).sort(), ['already_resolved', 'resolved']);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'incident.resolved'`);
  assert.strictEqual(rows[0].n, 1);
});

test('listActive y list: filtros, orden y paginación', async () => {
  // created_at tiene precisión de ms: separados para que el orden no dependa de un empate.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const a = await store.create({ ...NEW, title: 'Primero' });
  await tick();
  const b = await store.create({ ...NEW, title: 'Segundo', kind: 'maintenance' });
  await tick();
  const c = await store.create({ ...NEW, title: 'Tercero' });
  await store.resolve(a.id, { resolvedBy: 'x', note: null });

  assert.deepStrictEqual((await store.listActive()).map((i) => i.title), ['Tercero', 'Segundo']);

  const all = await store.list({ limit: 20 });
  assert.deepStrictEqual(all.items.map((i) => i.title), ['Tercero', 'Segundo', 'Primero']);
  assert.strictEqual(all.nextBefore, null);

  const resolved = await store.list({ status: 'resolved', limit: 20 });
  assert.deepStrictEqual(resolved.items.map((i) => i.id), [a.id]);

  const page1 = await store.list({ limit: 2 });
  assert.deepStrictEqual(page1.items.map((i) => i.id), [c.id, b.id]);
  assert.strictEqual(page1.nextBefore, b.createdAt.toISOString());
  const page2 = await store.list({ limit: 2, before: new Date(page1.nextBefore as string) });
  assert.deepStrictEqual(page2.items.map((i) => i.id), [a.id]);
  assert.strictEqual(page2.nextBefore, null);
});
