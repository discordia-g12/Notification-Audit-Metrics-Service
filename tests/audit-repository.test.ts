import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Pool } from 'pg';
import { insertAuditLog, listAuditLogs } from '../src/modules/audit/repository';
import { initAuditDatabase } from '../src/modules/audit/schema';

describe('Audit Repository', () => {
  it('initAuditDatabase executes schema DDL', async () => {
    let executedQuery = '';
    const poolMock = {
      query: async (sql: string) => {
        executedQuery = sql;
        return { rows: [] };
      },
    } as unknown as Pool;

    await initAuditDatabase(poolMock);
    assert.ok(executedQuery.includes('CREATE TABLE IF NOT EXISTS server_audit_logs'));
    assert.ok(executedQuery.includes('idx_audit_server_timeline'));
  });

  it('insertAuditLog inserts and maps returned row', async () => {
    let passedQuery = '';
    let passedValues: unknown[] = [];

    const mockRow = {
      id: 'uuid-1',
      event_id: 'evt-1',
      server_id: 'srv-1',
      category: 'members',
      action: 'MEMBER_BAN_ADD',
      actor_id: 'mod-1',
      target_id: 'u-1',
      reason: 'Toxic',
      changes: {},
      metadata: {},
      created_at: new Date('2026-11-10T10:00:00Z'),
    };

    const poolMock = {
      query: async (sql: string, values: unknown[]) => {
        passedQuery = sql;
        passedValues = values;
        return { rows: [mockRow] };
      },
    } as unknown as Pool;

    const entry = await insertAuditLog(poolMock, {
      eventId: 'evt-1',
      serverId: 'srv-1',
      category: 'members',
      action: 'MEMBER_BAN_ADD',
      actorId: 'mod-1',
      targetId: 'u-1',
      reason: 'Toxic',
      changes: {},
      metadata: {},
    });

    assert.ok(passedQuery.includes('INSERT INTO server_audit_logs'));
    assert.strictEqual(passedValues[0], 'evt-1');
    assert.strictEqual(entry?.id, 'uuid-1');
    assert.strictEqual(entry?.action, 'MEMBER_BAN_ADD');
    assert.strictEqual(entry?.createdAt, '2026-11-10T10:00:00.000Z');
  });

  it('insertAuditLog returns null when ON CONFLICT DO NOTHING produces 0 rows', async () => {
    const poolMock = {
      query: async () => ({ rows: [] }),
    } as unknown as Pool;

    const entry = await insertAuditLog(poolMock, {
      eventId: 'duplicate-evt',
      serverId: 'srv-1',
      category: 'members',
      action: 'MEMBER_BAN_ADD',
      actorId: 'mod-1',
    });

    assert.strictEqual(entry, null);
  });

  it('listAuditLogs filters and paginates results', async () => {
    let capturedQuery = '';
    let capturedValues: unknown[] = [];

    const mockRows = [
      {
        id: 'uuid-1',
        event_id: 'evt-1',
        server_id: 'srv-1',
        category: 'channels',
        action: 'CHANNEL_CREATE',
        actor_id: 'mod-1',
        target_id: 'ch-1',
        reason: null,
        changes: null,
        metadata: null,
        created_at: '2026-11-10T09:00:00.000Z',
      },
      {
        id: 'uuid-2',
        event_id: 'evt-2',
        server_id: 'srv-1',
        category: 'channels',
        action: 'CHANNEL_CREATE',
        actor_id: 'mod-1',
        target_id: 'ch-2',
        reason: null,
        changes: null,
        metadata: null,
        created_at: '2026-11-10T08:00:00.000Z',
      },
    ];

    const poolMock = {
      query: async (sql: string, values: unknown[]) => {
        capturedQuery = sql;
        capturedValues = values;
        return { rows: mockRows };
      },
    } as unknown as Pool;

    // Con filtros completos
    const page = await listAuditLogs(poolMock, 'srv-1', {
      category: 'channels',
      action: 'CHANNEL_CREATE',
      actorId: 'mod-1',
      before: '2026-11-10T10:00:00.000Z',
      limit: 1, // rows tiene 2 -> hasMore debe ser true
    });

    assert.ok(capturedQuery.includes('category = $2'));
    assert.ok(capturedQuery.includes('action = $3'));
    assert.ok(capturedQuery.includes('actor_id = $4'));
    assert.ok(capturedQuery.includes('created_at < $5'));
    assert.deepStrictEqual(capturedValues, ['srv-1', 'channels', 'CHANNEL_CREATE', 'mod-1', '2026-11-10T10:00:00.000Z', 2]);

    assert.strictEqual(page.items.length, 1);
    assert.strictEqual(page.hasMore, true);
    assert.strictEqual(page.nextCursor, '2026-11-10T09:00:00.000Z');
  });

  it('listAuditLogs handles empty results without hasMore', async () => {
    const poolMock = {
      query: async () => ({ rows: [] }),
    } as unknown as Pool;

    const page = await listAuditLogs(poolMock, 'srv-1');
    assert.strictEqual(page.items.length, 0);
    assert.strictEqual(page.hasMore, false);
    assert.strictEqual(page.nextCursor, null);
    assert.strictEqual(page.limit, 50);
  });
});
