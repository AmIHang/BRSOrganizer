import { invoke } from '@tauri-apps/api/core';
import type {
  CloneSync,
  CompleteResult,
  DaemonStatus,
  Item,
  PrDetails,
  SecretsStatus,
  Settings,
  StreamEvent,
} from './types';

type WritableSecret = 'github-token' | 'calendar-ics-url' | 'tfs-token';

interface Connection {
  baseUrl: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let connection: Promise<Connection> | null = null;

/** Asks the Rust side for daemon URL and token; it starts the daemon if needed. */
function connect(): Promise<Connection> {
  // Development only (stripped from release bundles): run the UI in a plain browser against a
  // dev daemon, configured in packages/app/.env.development.local (gitignored).
  if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
    const baseUrl = import.meta.env.VITE_BRSORGANIZER_URL as string | undefined;
    const token = import.meta.env.VITE_BRSORGANIZER_TOKEN as string | undefined;
    if (baseUrl && token) return Promise.resolve({ baseUrl, token });
  }
  connection ??= invoke<Connection>('connection').catch((e: unknown) => {
    connection = null;
    throw new Error(String(e));
  });
  return connection;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // One retry with a fresh connection: the daemon may have restarted (new port/token).
  for (let attempt = 0; ; attempt++) {
    const conn = await connect();
    let res: Response;
    try {
      res = await fetch(`${conn.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${conn.token}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (e) {
      connection = null;
      if (attempt === 0) continue;
      throw e;
    }
    if (res.status === 401 && attempt === 0) {
      connection = null;
      continue;
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError(
        res.status,
        String(json.error ?? 'error'),
        String(json.message ?? json.error ?? res.statusText),
      );
    }
    return json as T;
  }
}

export const api = {
  listItems: (status = 'open') =>
    request<{ items: Item[] }>('GET', `/api/items?status=${status}&limit=1000`).then(
      (r) => r.items,
    ),
  addTodo: (input: {
    title: string;
    dueAt?: string | null;
    notes?: string | null;
    link?: string | null;
    bsmUrl?: string | null;
    otmaUrl?: string | null;
  }) => request<Item>('POST', '/api/todos', input),
  /** BSM accepts a URL or just the ticket key; null clears. */
  setTickets: (id: string, tickets: { bsmUrl?: string | null; otmaUrl?: string | null }) =>
    request<Item>('PATCH', `/api/items/${id}/tickets`, tickets),
  addEvent: (input: { title: string; startsAt: string; endsAt?: string | null }) =>
    request<Item>('POST', '/api/events', input),
  updateTodo: (id: string, patch: Partial<Pick<Item, 'title' | 'notes' | 'link' | 'dueAt'>>) =>
    request<Item>('PATCH', `/api/todos/${id}`, patch),
  complete: (id: string) => request<Item>('POST', `/api/items/${id}/complete`),
  archive: (id: string) => request<Item>('POST', `/api/items/${id}/archive`),
  reopen: (id: string) => request<Item>('POST', `/api/items/${id}/reopen`),
  sync: () => request<unknown>('POST', '/api/sync'),
  pr: {
    cloneSync: (refresh = false) =>
      request<Record<string, CloneSync>>(
        'GET',
        `/api/prs/clone-sync${refresh ? '?refresh=1' : ''}`,
      ),
    details: (id: string, fetch = false) =>
      request<PrDetails>('GET', `/api/prs/${id}${fetch ? '?fetch=1' : ''}`),
    cloneOrUpdate: (id: string) => request<{ clonePath: string }>('POST', `/api/prs/${id}/clone`),
    removeLocal: (id: string) =>
      request<{ clonePath: string; ideClosed: number; ideForced: number }>(
        'POST',
        `/api/prs/${id}/remove-local`,
      ),
    open: (id: string, target: 'solution' | 'folder') =>
      request<void>('POST', `/api/prs/${id}/open`, { target }),
    complete: (id: string, approve: boolean) =>
      request<CompleteResult>('POST', `/api/prs/${id}/complete`, { approve }),
  },
  status: () => request<DaemonStatus>('GET', '/api/status'),
  settings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (patch: Record<string, unknown>) =>
    request<Settings>('PATCH', '/api/settings', patch),
  secrets: () => request<SecretsStatus>('GET', '/api/secrets'),
  setSecret: (name: WritableSecret, value: string) =>
    request<void>('PUT', `/api/secrets/${name}`, { value }),
  deleteSecret: (name: WritableSecret) => request<void>('DELETE', `/api/secrets/${name}`),
};

/**
 * Subscribes to the daemon's server-sent events (via fetch, since EventSource cannot send
 * the Authorization header). Reconnects with backoff. Returns an unsubscribe function.
 */
export function subscribe(onEvent: (e: StreamEvent) => void, onConnected?: () => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  const run = async () => {
    let delay = 1000;
    while (!stopped) {
      try {
        const conn = await connect();
        controller = new AbortController();
        const res = await fetch(`${conn.baseUrl}/api/stream`, {
          headers: { Authorization: `Bearer ${conn.token}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);
        delay = 1000;
        onConnected?.();
        await readStream(res.body, onEvent);
      } catch {
        if (stopped) return;
        connection = null;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  };
  void run();

  return () => {
    stopped = true;
    controller?.abort();
  };
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseSseBlock(block);
      if (parsed) onEvent(parsed);
    }
  }
}

export function parseSseBlock(block: string): StreamEvent | null {
  let type = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { type, data: JSON.parse(data.join('\n')) } as StreamEvent;
  } catch {
    return null;
  }
}
