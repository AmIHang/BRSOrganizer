import type { BrowserContext, Cookie } from 'playwright-core';
import {
  BSM_ORIGIN,
  BSM_WORKFLOW_PATH,
  BsmLoginRequiredError,
  type BsmHttp,
  type BsmSession,
} from './bsm.js';
import { OTMA_ORIGIN } from './otma.js';

export interface EdgeBsmOptions {
  /** Edge profile of BRSOrganizer (in the data folder), separate from the user's own Edge. */
  profileDir: string;
  /** How long the login window waits for the user. */
  loginTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BSM and OTMA run on the same web framework (same API, same Keycloak login). */
interface System {
  origin: string;
  label: 'BSM' | 'OTMA';
}

function httpFor(ctx: BrowserContext, { origin, label }: System): BsmHttp {
  return {
    async runWorkflow(body) {
      const res = await ctx.request.post(`${origin}${BSM_WORKFLOW_PATH}`, {
        data: body,
        headers: { Accept: 'application/json' },
        maxRedirects: 0,
        timeout: 30_000,
      });
      // Without a session BSM answers 200 with an HTML page that starts the OAuth login, OTMA 401.
      const type = res.headers()['content-type'] ?? '';
      if (res.status() === 401 || res.status() === 403 || res.status() === 302) {
        throw new BsmLoginRequiredError(label);
      }
      if (!type.includes('json')) {
        if (type.includes('html')) throw new BsmLoginRequiredError(label);
        throw new Error(`${label}: unerwartete Antwort (${res.status()} ${type})`);
      }
      if (!res.ok()) throw new Error(`${label}: HTTP ${res.status()}`);
      return res.json() as Promise<unknown>;
    },
    async download(path) {
      if (!path.startsWith('/')) throw new Error(`${label}: path must start with /`);
      const res = await ctx.request.get(`${origin}${path}`, {
        maxRedirects: 0,
        timeout: 30_000,
      });
      if (!res.ok()) throw new Error(`${label}: HTTP ${res.status()} for an attachment`);
      return res.body();
    },
  };
}

/**
 * BSM and OTMA through Microsoft Edge (playwright-core, installed Edge, no browser download). Requests
 * run in a headless Edge with BRSOrganizer's own profile, so the systems see the user's login
 * cookies. Without a valid login, a visible Edge window opens on the system for the user to sign
 * in (Keycloak, one login for both); the request then runs in that window's session. Cookies stay in the profile and,
 * for session cookies, in this process's memory – never on disk elsewhere, never in logs.
 */
export function edgeTicketSessions(options: EdgeBsmOptions): { bsm: BsmSession; otma: BsmSession } {
  const loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000;
  const log = options.log ?? (() => undefined);
  // Session cookies (no expiry) do not survive closing Edge; carry them to the next run.
  let sessionCookies: Cookie[] = [];
  // One Edge per profile at a time: runs are serialized.
  let queue: Promise<unknown> = Promise.resolve();

  const launch = async (headless: boolean) => {
    const { chromium } = await import('playwright-core');
    const ctx = await chromium.launchPersistentContext(options.profileDir, {
      channel: 'msedge',
      headless,
      ...(headless ? {} : { viewport: null }),
    });
    const now = Date.now() / 1000;
    const valid = sessionCookies.filter((c) => c.expires === -1 || c.expires > now);
    if (valid.length) await ctx.addCookies(valid);
    return ctx;
  };

  const remember = async (ctx: BrowserContext) => {
    try {
      sessionCookies = (await ctx.cookies()).filter((c) => c.expires === -1);
    } catch {
      // context already gone
    }
  };

  /**
   * Opens the system in `ctx` (which starts the OAuth login) and runs `fn` once the page is back on
   * the system with a session. Undefined when the deadline passes; throws when the window was closed.
   */
  async function viaLogin<T>(
    system: System,
    ctx: BrowserContext,
    fn: (http: BsmHttp) => Promise<T>,
    timeoutMs: number,
    visible: boolean,
  ): Promise<{ result: T } | undefined> {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${system.origin}/`).catch(() => undefined);
    if (visible) await page.bringToFront().catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (page.isClosed()) {
        throw new Error(`${system.label}-Anmeldung abgebrochen (Fenster geschlossen)`);
      }
      const url = page.url();
      const onSystem = url.startsWith(`${system.origin}/`) && !/loginoa|LoginOAuth/i.test(url);
      if (onSystem) {
        try {
          return { result: await fn(httpFor(ctx, system)) };
        } catch (err) {
          if (!(err instanceof BsmLoginRequiredError)) throw err;
        }
      }
      if (Date.now() > deadline) return undefined;
      await sleep(visible ? 2_000 : 500);
    }
  }

  async function run<T>(system: System, fn: (http: BsmHttp) => Promise<T>): Promise<T> {
    const headless = await launch(true);
    try {
      try {
        return await fn(httpFor(headless, system));
      } catch (err) {
        if (!(err instanceof BsmLoginRequiredError)) throw err;
      }
      // No session (e.g. after a restart), but the Keycloak SSO login in the profile
      // usually still holds: the OAuth redirects then log in without any user input.
      const silent = await viaLogin(system, headless, fn, 15_000, false);
      if (silent) {
        log(`${system.label} session renewed via SSO`);
        return silent.result;
      }
    } finally {
      await remember(headless);
      await headless.close().catch(() => undefined);
    }

    log(`${system.label} login required, opening Edge for the user`);
    const ctx = await launch(false);
    try {
      const done = await viaLogin(system, ctx, fn, loginTimeoutMs, true);
      if (!done) throw new Error(`${system.label}-Anmeldung nicht abgeschlossen (Zeitlimit)`);
      log(`${system.label} login done`);
      return done.result;
    } finally {
      await remember(ctx);
      await ctx.close().catch(() => undefined);
    }
  }

  const session =
    (system: System): BsmSession =>
    <T>(fn: (http: BsmHttp) => Promise<T>): Promise<T> => {
      const next = queue.then(
        () => run(system, fn),
        () => run(system, fn),
      );
      queue = next.catch(() => undefined);
      return next;
    };
  return {
    bsm: session({ origin: BSM_ORIGIN, label: 'BSM' }),
    otma: session({ origin: OTMA_ORIGIN, label: 'OTMA' }),
  };
}
