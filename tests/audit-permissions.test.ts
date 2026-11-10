import { describe, it } from 'node:test';
import assert from 'node:assert';
import { checkServerModeratorAccess } from '../src/modules/audit/permissions';

describe('Audit Moderator Access Check', () => {
  it('allows access if user is server owner', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ is_owner: true, can_moderate: false }), { status: 200 });

    const result = await checkServerModeratorAccess('u-1', 'srv-1', 'http://roles:8080', fetchMock as unknown as typeof fetch);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.isOwner, true);
  });

  it('allows access if user has can_moderate', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ is_owner: false, can_moderate: true }), { status: 200 });

    const result = await checkServerModeratorAccess('u-1', 'srv-1', 'http://roles:8080', fetchMock as unknown as typeof fetch);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.canModerate, true);
  });

  it('denies access if user is neither owner nor moderator', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ is_owner: false, can_moderate: false }), { status: 200 });

    const result = await checkServerModeratorAccess('u-1', 'srv-1', 'http://roles:8080', fetchMock as unknown as typeof fetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.isOwner, false);
    assert.strictEqual(result.canModerate, false);
  });

  it('handles 404 server or member not found', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });

    const result = await checkServerModeratorAccess('u-1', 'srv-404', 'http://roles:8080', fetchMock as unknown as typeof fetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.notFound, true);
  });

  it('handles 403 non-member', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ detail: 'Forbidden' }), { status: 403 });

    const result = await checkServerModeratorAccess('u-1', 'srv-1', 'http://roles:8080', fetchMock as unknown as typeof fetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.notFound, undefined);
  });

  it('handles 500 upstream server error', async () => {
    const fetchMock = async () =>
      new Response('Internal Error', { status: 500 });

    const result = await checkServerModeratorAccess('u-1', 'srv-1', 'http://roles:8080', fetchMock as unknown as typeof fetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.upstreamError, true);
  });

  it('handles fetch network exception', async () => {
    const fetchMock = async () => {
      throw new Error('Connection refused');
    };

    const result = await checkServerModeratorAccess('u-1', 'srv-1', 'http://roles:8080', fetchMock as unknown as typeof fetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.upstreamError, true);
    assert.strictEqual(result.message, 'Connection refused');
  });
});
