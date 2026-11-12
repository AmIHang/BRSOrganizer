import type { Item } from '@amineeded/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pr, StaticSource } from '../../core/test/helpers.js';
import { auth, raw, startHarness, type Harness } from './harness.js';

describe('REST API', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(() => h.close());

  const call = (method: string, path: string, body?: unknown) =>
    raw(h.port, { method, path: `/api${path}`, headers: auth, body });

  it('creates todos attributed to the user and lists them', async () => {
    const created = await call('POST', '/todos', { title: 'Steuer', dueAt: '2026-11-20' });
    expect(created.status).toBe(201);
    expect(created.json<Item>()).toMatchObject({
      title: 'Steuer',
      createdBy: 'user',
      type: 'todo',
    });

    const list = await call('GET', '/items');
    expect(list.json<{ items: Item[] }>().items).toHaveLength(1);
  });

  it('maps domain errors to HTTP status codes', async () => {
    expect((await call('POST', '/todos', { title: '' })).status).toBe(400);
    expect((await call('POST', '/items/nope/complete')).status).toBe(404);

    await h.core.sync.run(new StaticSource('github', [pr('1')]));
    const [p] = h.core.items.list({ type: 'pr' });
    const r = await call('PATCH', `/todos/${p!.id}`, { title: 'x' });
    expect(r.status).toBe(409);
    expect(r.json()).toMatchObject({ error: 'forbidden' });
  });

  it('rejects malformed JSON with 400', async () => {
    const r = await raw(h.port, {
      method: 'POST',
      path: '/api/todos',
      headers: { ...auth, 'content-type': 'application/json' },
      body: undefined,
    });
    expect([400, 201]).toContain(r.status); // empty body → validation error
    const bad = await new Promise<number>((resolve) => {
      void import('node:http').then(({ request }) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: h.port,
            method: 'POST',
            path: '/api/todos',
            headers: { ...auth, 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.end('{not json');
      });
    });
    expect(bad).toBe(400);
  });

  it('completes, archives and reopens', async () => {
    const t = (await call('POST', '/todos', { title: 'a' })).json<Item>();
    expect((await call('POST', `/items/${t.id}/complete`)).json<Item>().status).toBe('done');
    expect((await call('POST', `/items/${t.id}/archive`)).json<Item>().status).toBe('archived');
    expect((await call('POST', `/items/${t.id}/reopen`)).json<Item>().status).toBe('open');
    expect(
      (await call('GET', '/items?status=open,done')).json<{ items: Item[] }>().items,
    ).toHaveLength(1);
    expect((await call('GET', '/items?status=bogus')).status).toBe(400);
  });

  it('has no DELETE route for items', async () => {
    const t = (await call('POST', '/todos', { title: 'a' })).json<Item>();
    expect((await call('DELETE', `/items/${t.id}`)).status).toBe(404);
    expect((await call('DELETE', `/todos/${t.id}`)).status).toBe(404);
    expect(h.core.items.get(t.id).status).toBe('open');
  });

  it('reads and validates settings', async () => {
    expect((await call('GET', '/settings')).json()).toMatchObject({ syncIntervalMinutes: 5 });
    expect((await call('PATCH', '/settings', { syncIntervalMinutes: 15 })).status).toBe(200);
    expect((await call('PATCH', '/settings', { syncIntervalMinutes: 0 })).status).toBe(400);
    expect((await call('PATCH', '/settings', { github: 'yes' })).status).toBe(400);
    expect((await call('PATCH', '/settings', { syncIntervallMinutes: 3 })).status).toBe(400);
    expect(h.core.settings.get().syncIntervalMinutes).toBe(15);
  });

  it('stores secrets write-only', async () => {
    expect((await call('GET', '/secrets')).json()).toEqual({
      githubToken: false,
      calendarIcsUrl: false,
    });
    expect((await call('PUT', '/secrets/github-token', { value: 'ghp_abc' })).status).toBe(204);
    expect(
      (await call('PUT', '/secrets/calendar-ics-url', { value: 'webcal://x.example/a.ics' }))
        .status,
    ).toBe(204);

    const status = await call('GET', '/secrets');
    expect(status.json()).toEqual({ githubToken: true, calendarIcsUrl: true });
    expect(status.body).not.toContain('ghp_abc');
    expect(h.core.secrets.get('github-token')).toBe('ghp_abc');

    expect((await call('PUT', '/secrets/github-token', { value: 'has space' })).status).toBe(400);
    expect((await call('PUT', '/secrets/calendar-ics-url', { value: 'file:///x' })).status).toBe(
      400,
    );
    // The local access token can neither be read nor replaced over HTTP.
    expect((await call('PUT', '/secrets/local-access-token', { value: 'x' })).status).toBe(400);

    expect((await call('DELETE', '/secrets/github-token')).status).toBe(204);
    expect(h.core.secrets.get('github-token')).toBeNull();
  });

  it('has no shutdown route unless the host process provides one', async () => {
    expect((await call('POST', '/shutdown')).status).toBe(404);
  });

  it('runs a sync on demand and reports status', async () => {
    const r = await call('POST', '/sync');
    expect(r.json()).toEqual({
      results: [],
      status: { github: 'missing-token', calendar: 'missing-url', mail: 'disabled' },
    });
    expect((await call('GET', '/status')).json()).toMatchObject({
      version: 'test',
      sources: { github: 'missing-token' },
    });
  });

  it('streams item changes as server-sent events', async () => {
    const res = await fetch(`${h.baseUrl}/api/stream`, { headers: auth });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil(': connected');

    await h.core.sync.run(new StaticSource('github', [pr('7', { title: 'Please review' })]));
    await readUntil('event: items-added');
    await readUntil('event: sync-finished');
    expect(text).toMatch(/event: items-changed/);
    expect(text).toContain('Please review');
    await reader.cancel();
  });
});
