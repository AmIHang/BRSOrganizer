import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, raw, startHarness, TOKEN, type Harness } from './harness.js';

describe('HTTP security', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it('serves /health without a token', async () => {
    const r = await raw(h.port, { path: '/health' });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, app: 'AmINeeded' });
  });

  it.each([
    ['rebound DNS name', 'evil.example.com'],
    ['rebound name with our port', `attacker.test:${0}`],
    ['wrong port', '127.0.0.1:1'],
    ['LAN address', '192.168.1.10'],
  ])('rejects foreign Host headers (%s)', async (_label, host) => {
    const hostHeader = host.endsWith(':0') ? host.replace(':0', `:${h.port}`) : host;
    const r = await raw(h.port, { path: '/health', headers: { host: hostHeader, ...auth } });
    expect(r.status).toBe(403);
    expect(r.json()).toEqual({ error: 'forbidden_host' });
  });

  it('accepts localhost and 127.0.0.1 with the right port', async () => {
    for (const host of [`localhost:${h.port}`, `127.0.0.1:${h.port}`]) {
      expect((await raw(h.port, { path: '/api/items', headers: { host, ...auth } })).status).toBe(
        200,
      );
    }
  });

  it.each(['https://evil.example.com', 'null', 'http://localhost:3000'])(
    'rejects foreign Origin %s, even with a valid token',
    async (origin) => {
      const r = await raw(h.port, { path: '/api/items', headers: { origin, ...auth } });
      expect(r.status).toBe(403);
      expect(r.json()).toEqual({ error: 'forbidden_origin' });
    },
  );

  it('rejects foreign origins on the MCP endpoint too', async () => {
    const r = await raw(h.port, {
      method: 'POST',
      path: '/mcp',
      headers: { origin: 'https://evil.example.com', ...auth },
      body: {},
    });
    expect(r.status).toBe(403);
  });

  it('answers CORS preflights for the Tauri origin without a token', async () => {
    const r = await raw(h.port, {
      method: 'OPTIONS',
      path: '/api/todos',
      headers: {
        origin: 'http://tauri.localhost',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    expect(String(r.headers['access-control-allow-headers'])).toMatch(/Authorization/);
  });

  it('adds CORS headers to allowed-origin requests', async () => {
    const r = await raw(h.port, {
      path: '/api/items',
      headers: { origin: 'http://tauri.localhost', ...auth },
    });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
  });

  it.each([
    ['no header', {}],
    ['wrong token', { authorization: 'Bearer nope' }],
    ['token prefix', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ['basic auth', { authorization: `Basic ${TOKEN}` }],
  ])('requires the bearer token (%s)', async (_label, headers) => {
    for (const path of ['/api/items', '/mcp']) {
      const r = await raw(h.port, { method: 'POST', path, headers, body: {} });
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toMatch(/^Bearer/);
    }
  });

  it('returns 404 JSON for unknown paths', async () => {
    const r = await raw(h.port, { path: '/nope', headers: auth });
    expect(r.status).toBe(404);
  });
});
