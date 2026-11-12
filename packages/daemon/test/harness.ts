import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySecretStore, type SecretKey } from '@amineeded/core';
import { pino } from 'pino';
import { makeCore } from '../../core/test/helpers.js';
import { createApp } from '../src/app.js';
import { DEFAULT_ALLOWED_ORIGINS } from '../src/http/security.js';
import { createScheduler } from '../src/scheduler.js';

export const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';

export interface Harness {
  core: ReturnType<typeof makeCore>;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startHarness(
  options: {
    secrets?: Partial<Record<SecretKey, string>>;
    /** Fixed port (e.g. to simulate a daemon restart); default: random free port. */
    port?: number;
  } & Parameters<typeof makeCore>[0] = {},
): Promise<Harness> {
  const { secrets, port: fixedPort, ...coreOptions } = options;
  const core = makeCore({ secrets: new MemorySecretStore(secrets ?? {}), ...coreOptions });
  const logger = pino({ level: 'silent' });
  const scheduler = createScheduler({ core, logger });
  let port = 0;
  const { app, close } = createApp({
    core,
    scheduler,
    logger,
    token: TOKEN,
    getPort: () => port,
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, 'http://localhost:1420'],
    version: 'test',
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(fixedPort ?? 0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  return {
    core,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      scheduler.stop();
      await close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      core.close();
    },
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = unknown>(): T;
}

/** Raw HTTP so tests can send arbitrary Host/Origin headers (fetch forbids that). */
export function raw(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<RawResponse> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          ...(payload && { 'content-type': 'application/json' }),
          ...opts.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T>() => JSON.parse(body) as T,
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export const auth = { authorization: `Bearer ${TOKEN}` };
