import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  mapEventToAuditLog,
  extractActor,
  extractTarget,
  extractReason,
  extractChanges,
  extractEventId,
} from '../src/modules/audit/event-mapper';

describe('Audit Event Mapper', () => {
  it('extract helper functions cover edge cases', () => {
    assert.strictEqual(extractActor(''), 'system');
    assert.strictEqual(extractActor(null), 'system');
    assert.strictEqual(extractActor('user-1'), 'user-1');

    assert.strictEqual(extractTarget(123), '');
    assert.strictEqual(extractTarget('target-1'), 'target-1');

    assert.strictEqual(extractReason(123), null);
    assert.strictEqual(extractReason('some reason'), 'some reason');

    assert.deepStrictEqual(extractChanges(null), {});
    assert.deepStrictEqual(extractChanges([1, 2]), {});
    assert.deepStrictEqual(extractChanges({ a: 1 }), { a: 1 });

    assert.strictEqual(extractEventId(null, null), null);
    assert.strictEqual(extractEventId('evt-1', null), 'evt-1');
    assert.strictEqual(extractEventId(null, 'msg-1'), 'msg-1');
  });
  it('returns null for non-object or missing payload', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(mapEventToAuditLog('member.banned', null as any), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(mapEventToAuditLog('member.banned', 'invalid' as any), null);
  });

  it('returns null when server_id is missing', () => {
    assert.strictEqual(mapEventToAuditLog('member.banned', { user_id: 'u-1' }), null);
  });

  it('returns null for unknown routing key', () => {
    assert.strictEqual(mapEventToAuditLog('unknown.event', { server_id: 'srv-1' }), null);
  });

  it('uses messageId when payload event_id is not present', () => {
    const entry = mapEventToAuditLog(
      'member.banned',
      { server_id: 'srv-1', user_id: 'u-1', banned_by: 'mod-1', reason: 'toxic' },
      'msg-id-123',
    );
    assert.strictEqual(entry?.eventId, 'msg-id-123');
    assert.strictEqual(entry?.actorId, 'mod-1');
    assert.strictEqual(entry?.targetId, 'u-1');
    assert.strictEqual(entry?.action, 'MEMBER_BAN_ADD');
    assert.strictEqual(entry?.category, 'members');
    assert.strictEqual(entry?.reason, 'toxic');
  });

  it('maps member events correctly', () => {
    // unban
    const unban = mapEventToAuditLog('member.unbanned', {
      server_id: 'srv-1',
      user_id: 'u-1',
      unbanned_by: 'mod-1',
    });
    assert.strictEqual(unban?.action, 'MEMBER_BAN_REMOVE');
    assert.strictEqual(unban?.actorId, 'mod-1');

    // kick
    const kick = mapEventToAuditLog('member.kicked', {
      server_id: 'srv-1',
      user_id: 'u-2',
      kicked_by: 'mod-2',
      reason: 'inactivity',
    });
    assert.strictEqual(kick?.action, 'MEMBER_KICK');
    assert.strictEqual(kick?.reason, 'inactivity');

    // mute
    const mute = mapEventToAuditLog('member.muted', {
      server_id: 'srv-1',
      user_id: 'u-3',
      muted_by: 'mod-3',
      expires_at: '2026-11-10T12:00:00Z',
      reason: 'spam',
    });
    assert.strictEqual(mute?.action, 'MEMBER_MUTE');
    assert.strictEqual(mute?.metadata?.expires_at, '2026-11-10T12:00:00Z');

    // unmute
    const unmute = mapEventToAuditLog('member.unmuted', {
      server_id: 'srv-1',
      user_id: 'u-3',
      unmuted_by: 'mod-1',
    });
    assert.strictEqual(unmute?.action, 'MEMBER_UNMUTE');
    assert.strictEqual(unmute?.actorId, 'mod-1');
  });

  it('maps role events correctly', () => {
    // role_assigned
    const assign = mapEventToAuditLog('member.role_assigned', {
      server_id: 'srv-1',
      user_id: 'u-1',
      role_id: 'r-1',
      role_name: 'Admin',
      assigned_by: 'owner-1',
    });
    assert.strictEqual(assign?.action, 'MEMBER_ROLE_ASSIGN');
    assert.strictEqual(assign?.metadata?.role_name, 'Admin');

    // role_removed
    const remove = mapEventToAuditLog('member.role_removed', {
      server_id: 'srv-1',
      user_id: 'u-1',
      role_id: 'r-1',
      role_name: 'Admin',
      removed_by: 'owner-1',
    });
    assert.strictEqual(remove?.action, 'MEMBER_ROLE_REMOVE');

    // role.created
    const rCreate = mapEventToAuditLog('role.created', {
      server_id: 'srv-1',
      role_id: 'r-2',
      name: 'Moderator',
      permissions: 128,
      position: 2,
      is_default: false,
      created_by: 'admin-1',
    });
    assert.strictEqual(rCreate?.action, 'ROLE_CREATE');
    assert.strictEqual(rCreate?.metadata?.name, 'Moderator');

    // role.updated
    const rUpdate = mapEventToAuditLog('role.updated', {
      server_id: 'srv-1',
      role_id: 'r-2',
      name: 'Mod',
      changes: { name: { old: 'Moderator', new: 'Mod' } },
      updated_by: 'admin-1',
    });
    assert.strictEqual(rUpdate?.action, 'ROLE_UPDATE');
    assert.deepStrictEqual(rUpdate?.changes, { name: { old: 'Moderator', new: 'Mod' } });

    // role.updated sin changes explícito
    const rUpdateNoChanges = mapEventToAuditLog('role.updated', {
      server_id: 'srv-1',
      role_id: 'r-2',
      name: 'Mod',
      updated_by: 'admin-1',
    });
    assert.deepStrictEqual(rUpdateNoChanges?.changes, {});

    // role.permissions_updated
    const rPerms = mapEventToAuditLog('role.permissions_updated', {
      server_id: 'srv-1',
      role_id: 'r-2',
      name: 'Mod',
      old_permissions: 128,
      new_permissions: 256,
      updated_by: 'admin-1',
    });
    assert.strictEqual(rPerms?.action, 'ROLE_PERMISSIONS_UPDATE');
    assert.deepStrictEqual(rPerms?.changes, { permissions: { old: 128, new: 256 } });

    // role.permissions_updated with bitmask fallback
    const rPermsBitmask = mapEventToAuditLog('role.permissions_updated', {
      server_id: 'srv-1',
      role_id: 'r-2',
      name: 'Mod',
      old_permissions_bitmask: 0,
      new_permissions_bitmask: 1024,
      updated_by: 'admin-1',
    });
    assert.strictEqual(rPermsBitmask?.action, 'ROLE_PERMISSIONS_UPDATE');
    assert.deepStrictEqual(rPermsBitmask?.changes, { permissions: { old: 0, new: 1024 } });

    // role.deleted
    const rDelete = mapEventToAuditLog('role.deleted', {
      server_id: 'srv-1',
      role_id: 'r-2',
      name: 'Mod',
      deleted_by: 'admin-1',
    });
    assert.strictEqual(rDelete?.action, 'ROLE_DELETE');
    assert.strictEqual(rDelete?.metadata?.name, 'Mod');
  });

  it('maps channel and category events correctly', () => {
    // channel.created
    const chCreate = mapEventToAuditLog('channel.created', {
      server_id: 'srv-1',
      channel_id: 'ch-1',
      name: 'general',
      type: 'text',
      category_id: 'cat-1',
      created_by: 'admin-1',
    });
    assert.strictEqual(chCreate?.action, 'CHANNEL_CREATE');
    assert.strictEqual(chCreate?.category, 'channels');

    // channel.updated
    const chUpdate = mapEventToAuditLog('channel.updated', {
      server_id: 'srv-1',
      channel_id: 'ch-1',
      name: 'chat',
      changes: { name: { old: 'general', new: 'chat' } },
      updated_by: 'admin-1',
    });
    assert.strictEqual(chUpdate?.action, 'CHANNEL_UPDATE');

    const chUpdateNoChanges = mapEventToAuditLog('channel.updated', {
      server_id: 'srv-1',
      channel_id: 'ch-1',
      name: 'chat',
      updated_by: 'admin-1',
    });
    assert.deepStrictEqual(chUpdateNoChanges?.changes, {});

    // channel.deleted
    const chDelete = mapEventToAuditLog('channel.deleted', {
      server_id: 'srv-1',
      channel_id: 'ch-1',
      name: 'chat',
      type: 'text',
      deleted_by: 'admin-1',
    });
    assert.strictEqual(chDelete?.action, 'CHANNEL_DELETE');

    // category.created
    const catCreate = mapEventToAuditLog('category.created', {
      server_id: 'srv-1',
      category_id: 'cat-1',
      name: 'Text Channels',
      created_by: 'admin-1',
    });
    assert.strictEqual(catCreate?.action, 'CATEGORY_CREATE');
    assert.strictEqual(catCreate?.category, 'categories');

    // category.updated
    const catUpdate = mapEventToAuditLog('category.updated', {
      server_id: 'srv-1',
      category_id: 'cat-1',
      name: 'Salas',
      changes: { name: { old: 'Text Channels', new: 'Salas' } },
      updated_by: 'admin-1',
    });
    assert.strictEqual(catUpdate?.action, 'CATEGORY_UPDATE');

    const catUpdateNoChanges = mapEventToAuditLog('category.updated', {
      server_id: 'srv-1',
      category_id: 'cat-1',
      name: 'Salas',
      updated_by: 'admin-1',
    });
    assert.deepStrictEqual(catUpdateNoChanges?.changes, {});

    // category.deleted
    const catDelete = mapEventToAuditLog('category.deleted', {
      server_id: 'srv-1',
      category_id: 'cat-1',
      name: 'Salas',
      deleted_by: 'admin-1',
    });
    assert.strictEqual(catDelete?.action, 'CATEGORY_DELETE');
  });

  it('maps server, invite and message events correctly', () => {
    // server.updated
    const srvUpdate = mapEventToAuditLog('server.updated', {
      server_id: 'srv-1',
      changes: { icon_url: { old: null, new: 'https://icon.png' } },
      updated_by: 'owner-1',
    });
    assert.strictEqual(srvUpdate?.action, 'SERVER_UPDATE');
    assert.strictEqual(srvUpdate?.category, 'server');

    const srvUpdateNoChanges = mapEventToAuditLog('server.updated', {
      server_id: 'srv-1',
      updated_by: 'owner-1',
    });
    assert.deepStrictEqual(srvUpdateNoChanges?.changes, {});

    // server.ownership_transferred
    const transfer = mapEventToAuditLog('server.ownership_transferred', {
      server_id: 'srv-1',
      previous_owner_id: 'owner-old',
      new_owner_id: 'owner-new',
    });
    assert.strictEqual(transfer?.action, 'SERVER_TRANSFER');
    assert.strictEqual(transfer?.actorId, 'owner-old');
    assert.strictEqual(transfer?.targetId, 'owner-new');

    // invite.created
    const invCreate = mapEventToAuditLog('invite.created', {
      server_id: 'srv-1',
      code: 'abc1234',
      created_by: 'user-1',
      max_uses: 10,
      expires_at: '2026-12-01T00:00:00Z',
    });
    assert.strictEqual(invCreate?.action, 'INVITE_CREATE');
    assert.strictEqual(invCreate?.category, 'invites');
    assert.strictEqual(invCreate?.metadata?.code, 'abc1234');

    // invite.revoked
    const invRevoke = mapEventToAuditLog('invite.revoked', {
      server_id: 'srv-1',
      code: 'abc1234',
      revoked_by: 'mod-1',
    });
    assert.strictEqual(invRevoke?.action, 'INVITE_REVOKE');

    // message.deleted_by_moderator
    const msgDelete = mapEventToAuditLog('message.deleted_by_moderator', {
      server_id: 'srv-1',
      channel_id: 'ch-1',
      message_id: 'm-1',
      author_id: 'bad-user',
      deleted_by: 'mod-1',
      reason: 'Spam links',
    });
    assert.strictEqual(msgDelete?.action, 'MESSAGE_DELETE');
    assert.strictEqual(msgDelete?.category, 'messages');
    assert.strictEqual(msgDelete?.actorId, 'mod-1');
    assert.strictEqual(msgDelete?.targetId, 'bad-user');
    assert.strictEqual(msgDelete?.reason, 'Spam links');
    assert.strictEqual(msgDelete?.metadata?.channel_id, 'ch-1');
  });

  it('falls back actorId to system if actor is missing', () => {
    const entry = mapEventToAuditLog('member.banned', {
      server_id: 'srv-1',
      user_id: 'u-1',
    });
    assert.strictEqual(entry?.actorId, 'system');
  });
});
