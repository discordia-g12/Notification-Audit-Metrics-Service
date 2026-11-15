import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert';
import type { FastifyInstance } from 'fastify';
import buildApp from '../src/app';
import type { IncidentStore } from '../src/modules/incidents/types';
import { createMigratedSchema } from './db-helpers';
import { allOk, DOWN, fakeMonitor } from './status-helpers';

type Db = Awaited<ReturnType<typeof createMigratedSchema>>;
let db: Db;
let app: FastifyInstance;
let monitor: ReturnType<typeof fakeMonitor>['monitor'];

const STAFF = { 'x-user-role': 'staff', 'x-user-id': 'auth0|staff-1' };
const BASE = '/api/v1/admin/incidents';
const VALID = {
  title: 'Demoras en la voz',
  description: 'Los canales de voz tardan en conectar.',
  kind: 'degraded',
  affectedServices: ['voice'],
};

before(async () => {
  db = await createMigratedSchema();
  monitor = fakeMonitor(allOk()).monitor;
  app = buildApp({ databaseUrl: db.url, env: {}, statusMonitor: monitor, logger: false });
  await app.ready();
  await monitor.poll();
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE incidents, audit_logs');
});

after(async () => {
  await app.close();
  await db.drop();
});

function create(body: object = VALID, headers: Record<string, string> = STAFF) {
  return app.inject({ method: 'POST', url: BASE, headers, payload: body });
}

function resolve(id: string, body: object = {}, headers: Record<string, string> = STAFF) {
  return app.inject({ method: 'POST', url: `${BASE}/${id}/resolve`, headers, payload: body });
}

function publicStatus() {
  return app.inject({ method: 'GET', url: '/api/v1/status' });
}

// --- CA1 / CA2 / CA3 de punta a punta dentro del servicio ---

test('CA1+CA3: el incidente publicado aparece en el estado público; CA2: al resolverlo desaparece', async () => {
  let body = (await publicStatus()).json();
  assert.strictEqual(body.status, 'operational');
  assert.deepStrictEqual(body.incidents, []);

  const created = await create({ ...VALID, affectedServices: ['voice', 'chat'] });
  assert.strictEqual(created.statusCode, 201);
  const incident = created.json();
  assert.strictEqual(created.headers.location, `${BASE}/${incident.id}`);
  assert.strictEqual(created.headers['cache-control'], 'no-store');
  // Orden del catálogo, no el del pedido.
  assert.deepStrictEqual(incident.affectedServices, ['chat', 'voice']);
  assert.strictEqual(incident.createdBy, 'auth0|staff-1');
  assert.strictEqual(incident.status, 'active');

  body = (await publicStatus()).json();
  assert.strictEqual(body.status, 'degraded');
  assert.strictEqual(body.services.find((s: { id: string }) => s.id === 'voice').status, 'degraded');
  assert.strictEqual(body.services.find((s: { id: string }) => s.id === 'auth').status, 'operational');
  assert.deepStrictEqual(body.incidents, [
    {
      id: incident.id,
      kind: 'degraded',
      title: VALID.title,
      description: VALID.description,
      affectedServices: ['chat', 'voice'],
      startedAt: incident.startedAt,
    },
  ]);

  const resolved = await resolve(incident.id, { note: '  Se reinició LiveKit  ' });
  assert.strictEqual(resolved.statusCode, 200);
  assert.strictEqual(resolved.json().status, 'resolved');
  assert.strictEqual(resolved.json().resolutionNote, 'Se reinició LiveKit');

  body = (await publicStatus()).json();
  assert.strictEqual(body.status, 'operational');
  assert.deepStrictEqual(body.incidents, []);
});

test('CA3: mantenimiento → estado global "maintenance" aunque la sonda del servicio esté caída', async () => {
  const results = allOk();
  results.set('payments', DOWN);
  const local = fakeMonitor(results).monitor;
  const other = buildApp({ databaseUrl: db.url, env: {}, statusMonitor: local, logger: false });
  await other.ready();
  await local.poll();
  try {
    const created = await other.inject({
      method: 'POST',
      url: BASE,
      headers: STAFF,
      payload: { ...VALID, kind: 'maintenance', affectedServices: ['payments'] },
    });
    assert.strictEqual(created.statusCode, 201);
    const body = (await other.inject({ method: 'GET', url: '/api/v1/status' })).json();
    assert.strictEqual(body.status, 'maintenance');
    assert.strictEqual(body.services.find((s: { id: string }) => s.id === 'payments').status, 'maintenance');
  } finally {
    await other.close();
  }
});

test('el estado público no expone autor ni datos de cierre', async () => {
  await create();
  const [incident] = (await publicStatus()).json().incidents;
  assert.deepStrictEqual(Object.keys(incident).sort(), [
    'affectedServices',
    'description',
    'id',
    'kind',
    'startedAt',
    'title',
  ]);
});

test('create: recorta espacios y guarda la auditoría', async () => {
  const res = await create({ ...VALID, title: '  Caída del chat  ', description: '\n Sin mensajes nuevos \n' });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.json().title, 'Caída del chat');
  assert.strictEqual(res.json().description, 'Sin mensajes nuevos');
  const { rows } = await db.pool.query(`SELECT actor_id, action FROM audit_logs`);
  assert.deepStrictEqual(rows, [{ actor_id: 'auth0|staff-1', action: 'incident.created' }]);
});

// --- Validaciones ---

const invalidBodies: Array<[string, object, string]> = [
  ['sin título', { ...VALID, title: undefined }, 'title'],
  ['título corto', { ...VALID, title: 'ab' }, 'title'],
  ['título solo espacios', { ...VALID, title: '      ' }, 'title'],
  ['título largo', { ...VALID, title: 'x'.repeat(121) }, 'title'],
  ['descripción vacía', { ...VALID, description: '   ' }, 'description'],
  ['descripción larga', { ...VALID, description: 'x'.repeat(1001) }, 'description'],
  ['tipo inválido', { ...VALID, kind: 'outage' }, 'kind'],
  ['sin servicios', { ...VALID, affectedServices: [] }, 'affectedServices'],
  ['servicio fuera del catálogo', { ...VALID, affectedServices: ['mongo'] }, 'affectedServices.0'],
  ['servicio repetido', { ...VALID, affectedServices: ['chat', 'chat'] }, 'affectedServices'],
  // Fastify coerce un escalar a array (coerceTypes: 'array'): "chat" pasa como ["chat"], un número no.
  ['servicios con un número', { ...VALID, affectedServices: 5 }, 'affectedServices.0'],
  ['servicios como objeto', { ...VALID, affectedServices: { chat: true } }, 'affectedServices'],
];

for (const [label, body, field] of invalidBodies) {
  test(`create: 400 problem+json (${label})`, async () => {
    const res = await create(body);
    assert.strictEqual(res.statusCode, 400);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    const problem = res.json();
    assert.strictEqual(problem.title, 'Bad Request');
    assert.strictEqual(problem.instance, BASE);
    assert.ok(
      problem.errors.some((e: { field: string }) => e.field === field),
      `se esperaba un error en ${field}: ${JSON.stringify(problem.errors)}`,
    );
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM incidents');
    assert.strictEqual(rows[0].n, 0);
  });
}

test('create: JSON malformado → 400 problem+json', async () => {
  const res = await app.inject({
    method: 'POST',
    url: BASE,
    headers: { ...STAFF, 'content-type': 'application/json' },
    payload: '{"title":',
  });
  assert.strictEqual(res.statusCode, 400);
  assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
});

test('resolve: 404 si no existe, 409 si ya estaba resuelto, 400 con id o nota inválidos', async () => {
  const missing = await resolve('00000000-0000-4000-8000-000000000000');
  assert.strictEqual(missing.statusCode, 404);
  assert.match(String(missing.headers['content-type']), /^application\/problem\+json/);

  const badId = await resolve('no-es-un-uuid');
  assert.strictEqual(badId.statusCode, 400);
  assert.strictEqual(badId.json().errors[0].field, 'id');

  const id = (await create()).json().id;
  const longNote = await resolve(id, { note: 'x'.repeat(1001) });
  assert.strictEqual(longNote.statusCode, 400);
  const numericNote = await resolve(id, { note: 42 });
  assert.strictEqual(numericNote.statusCode, 400);

  // Sin body también se puede resolver; la nota vacía queda null.
  const ok = await app.inject({ method: 'POST', url: `${BASE}/${id.toUpperCase()}/resolve`, headers: STAFF });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.json().resolutionNote, null);
  assert.strictEqual(ok.json().resolvedBy, 'auth0|staff-1');

  const again = await resolve(id);
  assert.strictEqual(again.statusCode, 409);
  assert.strictEqual(again.json().detail, 'El incidente ya estaba resuelto');
});

test('list: historial con filtro, paginación y validación de parámetros', async () => {
  const first = (await create({ ...VALID, title: 'Primero' })).json();
  await new Promise((r) => setTimeout(r, 5));
  await create({ ...VALID, title: 'Segundo' });
  await resolve(first.id, { note: 'listo' });

  const all = await app.inject({ method: 'GET', url: BASE, headers: STAFF });
  assert.strictEqual(all.statusCode, 200);
  assert.deepStrictEqual(all.json().items.map((i: { title: string }) => i.title), ['Segundo', 'Primero']);
  assert.strictEqual(all.json().nextBefore, null);

  const resolved = (await app.inject({ method: 'GET', url: `${BASE}?status=resolved`, headers: STAFF })).json();
  assert.deepStrictEqual(resolved.items.map((i: { id: string }) => i.id), [first.id]);
  assert.strictEqual(resolved.items[0].resolutionNote, 'listo');

  const page = (await app.inject({ method: 'GET', url: `${BASE}?limit=1`, headers: STAFF })).json();
  assert.strictEqual(page.items.length, 1);
  const next = (
    await app.inject({ method: 'GET', url: `${BASE}?limit=1&before=${encodeURIComponent(page.nextBefore)}`, headers: STAFF })
  ).json();
  assert.deepStrictEqual(next.items.map((i: { title: string }) => i.title), ['Primero']);

  for (const query of ['limit=0', 'limit=101', 'status=open', 'before=ayer', 'limit=abc']) {
    const res = await app.inject({ method: 'GET', url: `${BASE}?${query}`, headers: STAFF });
    assert.strictEqual(res.statusCode, 400, query);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
  }
});

// --- CA4: sin rol staff ---

const forbidden: Array<[string, Record<string, string>]> = [
  ['sin header', {}],
  ['rol user', { 'x-user-role': 'user', 'x-user-id': 'auth0|user' }],
  ['Staff con mayúscula', { 'x-user-role': 'Staff', 'x-user-id': 'auth0|user' }],
];

for (const [label, headers] of forbidden) {
  test(`CA4: 403 en publicar, resolver y listar (${label}), sin escribir nada`, async () => {
    const id = (await create()).json().id;
    for (const res of [
      await create(VALID, headers),
      // Body inválido: igual 403, el rol se chequea antes que el esquema.
      await create({}, headers),
      await resolve(id, {}, headers),
      await app.inject({ method: 'GET', url: BASE, headers }),
    ]) {
      assert.strictEqual(res.statusCode, 403);
      assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
      assert.strictEqual(res.json().detail, 'Forbidden: staff only');
    }
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n, bool_and(status = 'active') AS active FROM incidents`);
    assert.deepStrictEqual(rows[0], { n: 1, active: true });
  });
}

test('CA4: staff sin X-User-Id no puede escribir (no hay a quién auditar)', async () => {
  const res = await create(VALID, { 'x-user-role': 'staff' });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.json().detail, 'Forbidden: missing user identity');
});

// --- Fallas de la base ---

test('store que falla: 500 problem+json sin detalle interno; el estado público sigue saliendo', async () => {
  const failing: IncidentStore = {
    create: async () => {
      throw Object.assign(new Error('password authentication failed for user "postgres"'), { code: '28P01' });
    },
    resolve: async () => {
      throw new Error('boom');
    },
    list: async () => {
      throw new Error('boom');
    },
    listActive: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.1.5:5432'), { code: 'ECONNREFUSED' });
    },
  };
  const local = fakeMonitor(allOk()).monitor;
  const broken = buildApp({ databaseUrl: db.url, env: {}, statusMonitor: local, incidentStore: failing, logger: false });
  await broken.ready();
  try {
    const res = await broken.inject({ method: 'POST', url: BASE, headers: STAFF, payload: VALID });
    assert.strictEqual(res.statusCode, 500);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    assert.strictEqual(res.json().detail, 'No se pudo procesar la solicitud');
    assert.ok(!res.body.includes('postgres'));

    const status = await broken.inject({ method: 'GET', url: '/api/v1/status' });
    assert.strictEqual(status.statusCode, 200);
    assert.deepStrictEqual(status.json().incidents, []);
    assert.ok(!status.body.includes('10.0.1.5'));
  } finally {
    await broken.close();
  }
});
