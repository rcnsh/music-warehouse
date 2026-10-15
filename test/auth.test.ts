import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { accessFor, clientAddress, clientKey, sha256Hex } from '../src/auth';
import worker from '../src/index';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token' };

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function mint(body: Record<string, unknown>, headers: Record<string, string> = ADMIN) {
  return SELF.fetch(`${BASE}/admin/tokens`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function mintOk(body: Record<string, unknown>) {
  const response = await mint(body);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; token: string; access: string; expires_ms: number | null };
}

describe('device tokens', () => {
  it('mints a read token that expires in 90 days by default', async () => {
    const before = Date.now();
    const minted = await mintOk({ name: 'iPhone' });

    expect(minted.token).toMatch(/^mw_[A-Za-z0-9_-]{43}$/);
    expect(minted.access).toBe('read');
    expect(minted.expires_ms! - before).toBeGreaterThanOrEqual(90 * 86_400_000);
    expect(minted.expires_ms! - before).toBeLessThan(91 * 86_400_000);
  });

  it('stores only a hash of the token', async () => {
    const minted = await mintOk({ name: 'iPhone' });
    const row = await env.DB.prepare('SELECT * FROM api_tokens WHERE id = ?').bind(minted.id).first<Record<string, unknown>>();

    expect(row!.token_hash).toBe(await sha256Hex(minted.token));
    expect(Object.values(row!)).not.toContain(minted.token);
  });

  it('gives a read token /api/* and nothing else', async () => {
    const { token } = await mintOk({ name: 'iPhone' });

    expect((await SELF.fetch(`${BASE}/api/plays`, { headers: bearer(token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/health`, { headers: bearer(token) })).status).toBe(401);
    expect((await mint({ name: 'escalated', access: 'admin' }, bearer(token))).status).toBe(401);
  });

  it('gives an admin token everything, including minting', async () => {
    const { token } = await mintOk({ name: 'laptop', access: 'admin' });

    expect((await SELF.fetch(`${BASE}/health`, { headers: bearer(token) })).status).toBe(200);
    expect((await mint({ name: 'another' }, bearer(token))).status).toBe(201);
  });

  it('can mint a token that never expires', async () => {
    const minted = await mintOk({ name: 'cron script', expires_in_days: null });
    expect(minted.expires_ms).toBeNull();
    expect((await SELF.fetch(`${BASE}/api/plays`, { headers: bearer(minted.token) })).status).toBe(200);
  });

  it('stops accepting a token once it expires', async () => {
    const { id, token } = await mintOk({ name: 'iPhone' });
    await env.DB.prepare('UPDATE api_tokens SET expires_ms = ? WHERE id = ?').bind(Date.now() - 1, id).run();
    expect((await SELF.fetch(`${BASE}/api/plays`, { headers: bearer(token) })).status).toBe(401);
  });

  it('stops accepting a token once it is revoked, and keeps the row', async () => {
    const { id, token } = await mintOk({ name: 'lost phone' });

    const revoked = await SELF.fetch(`${BASE}/admin/tokens?id=${id}`, { method: 'DELETE', headers: ADMIN });
    expect(revoked.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/plays`, { headers: bearer(token) })).status).toBe(401);

    const list = (await (await SELF.fetch(`${BASE}/admin/tokens`, { headers: ADMIN })).json()) as {
      tokens: Array<{ id: string; active: boolean; revoked_ms: number | null }>;
    };
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]).toMatchObject({ id, active: false });
    expect(list.tokens[0]!.revoked_ms).not.toBeNull();
  });

  it('404s revoking a token that does not exist', async () => {
    const response = await SELF.fetch(`${BASE}/admin/tokens?id=tok_nope`, { method: 'DELETE', headers: ADMIN });
    expect(response.status).toBe(404);
  });

  it('never lists token hashes', async () => {
    await mintOk({ name: 'iPhone' });
    const body = await (await SELF.fetch(`${BASE}/admin/tokens`, { headers: ADMIN })).text();
    expect(body).not.toContain('token_hash');
    expect(body).not.toContain('mw_');
  });

  it('records when a token was last used', async () => {
    const { id, token } = await mintOk({ name: 'iPhone' });
    await SELF.fetch(`${BASE}/api/plays`, { headers: bearer(token) });
    const row = await env.DB.prepare('SELECT last_used_ms FROM api_tokens WHERE id = ?').bind(id).first<{ last_used_ms: number | null }>();
    expect(row!.last_used_ms).not.toBeNull();
  });

  it.each([
    [{}],
    [{ name: '' }],
    [{ name: 'x'.repeat(65) }],
    [{ name: 'iPhone', access: 'owner' }],
    [{ name: 'iPhone', expires_in_days: 0 }],
    [{ name: 'iPhone', expires_in_days: 1.5 }],
  ])('rejects %j with 400', async (body) => {
    expect((await mint(body)).status).toBe(400);
  });

  it('rejects a body that is not an object', async () => {
    const response = await SELF.fetch(`${BASE}/admin/tokens`, { method: 'POST', headers: ADMIN, body: 'null' });
    expect(response.status).toBe(400);
  });

  it('rejects a token with the right prefix that was never minted', async () => {
    const response = await SELF.fetch(`${BASE}/api/plays`, { headers: bearer(`mw_${'A'.repeat(43)}`) });
    expect(response.status).toBe(401);
  });
});

describe('cheap refusals', () => {
  /** An env whose D1 fails the test if asked anything. */
  const noDb = {
    ...env,
    DB: {
      prepare() {
        throw new Error('D1 was queried');
      },
    } as unknown as D1Database,
  };

  it.each(['mw_short', `mw_${'A'.repeat(42)}!`, `mw_${'A'.repeat(44)}`, `xx_${'A'.repeat(43)}`, 'anything at all'])(
    'refuses %s without a D1 lookup',
    async (token) => {
      const request = new Request(`${BASE}/api/plays`, { headers: bearer(token) });
      expect(await accessFor(request, noDb, createExecutionContext())).toBeNull();
    },
  );

  it('still looks up a token shaped like a minted one', async () => {
    const request = new Request(`${BASE}/api/plays`, { headers: bearer(`mw_${'A'.repeat(43)}`) });
    await expect(accessFor(request, noDb, createExecutionContext())).rejects.toThrow('D1 was queried');
  });
});

describe('READ_TOKEN', () => {
  it('still works, and logs that it is deprecated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const request = new Request(`${BASE}/api/plays`, { headers: bearer('test-read-token') });
      expect(await accessFor(request, env, createExecutionContext())).toBe('read');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'read-token-deprecated', message: expect.stringContaining('READ_TOKEN used: it is deprecated') }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('client addresses', () => {
  it.each([
    ['198.51.100.7', '198.51.100.7'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002::', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('counts %s as %s', (ip, expected) => {
    expect(clientAddress(ip)).toBe(expected);
  });

  it('keys a client by a hash, and not at all without CF-Connecting-IP', async () => {
    const key = await clientKey(new Request(BASE, { headers: { 'CF-Connecting-IP': '198.51.100.7' } }), env);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(await sha256Hex('198.51.100.7'));
    expect(await clientKey(new Request(BASE), env)).toBeNull();
  });
});

describe('sign-in without the rate limiter bound', () => {
  it('runs on the pending cap alone', async () => {
    const bare = { ...env, AUTH_RATE_LIMITER: undefined };
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const request = new Request(`${BASE}/auth/login?name=laptop`, { headers: { 'CF-Connecting-IP': '192.0.2.80' } });
      statuses.push((await worker.fetch(request, bare, createExecutionContext())).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
  });
});
