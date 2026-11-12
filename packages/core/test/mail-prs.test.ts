import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/secrets/store.js';
import {
  classifyMail,
  openPrsFromMails,
  parsePrUrl,
  parseSubject,
  type PrMail,
} from '../src/sync/mail-prs.js';
import { HOUR, makeCore } from './helpers.js';

const ME = 'Muster Max';

/** Safelinks-wrapped PR link as Outlook delivers it. */
function prLink(id: number, repo = 'Community', project = 'Produktion'): string {
  const target = `https://tfs.example.com/tfs/boom/${project}/_git/${repo}/pullrequest/${id}?tracking_data=abc`;
  return `https://eur04.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&amp;data=05%7C02&amp;reserved=0`;
}

function mail(
  id: number,
  eventLine: string,
  at: string,
  opts: { title?: string; author?: string; repo?: string; links?: string[] } = {},
): PrMail {
  const title = opts.title ?? `feature ${id}`;
  const author = opts.author ?? 'Kollege Karl';
  const repo = opts.repo ?? 'Community';
  return {
    receivedAt: at,
    subject: `PR – ${title.length > 45 ? `${title.slice(0, 45)}...` : title} – ${repo} ${id} (${author})`,
    body: [
      eventLine,
      '\t <https://tfs.example.com/tfs/_static/content/notifications/v3/microsoft.png> \tAzure DevOps Server \t',
      `${title} \t`,
      `${eventLine} \t`,
    ].join('\r\n'),
    urls: opts.links ?? [prLink(id, repo)],
  };
}

const T = (h: number) => new Date(Date.UTC(2026, 10, 9, h)).toISOString();

describe('mail parsing', () => {
  it('classifies the event from the first body line', () => {
    expect(classifyMail('Kollege Karl hat den Pull Request abgeschlossen.\nmore')).toBe(
      'completed',
    );
    expect(classifyMail('\n\nKollege Karl hat den Pull Request aufgegeben.')).toBe('abandoned');
    expect(classifyMail('Kollege Karl hat den Pull Request reaktiviert.')).toBe('reactivated');
    expect(classifyMail('Kollege Karl hat einen neuen Pull Request erstellt.')).toBe('created');
    expect(classifyMail('A B und Muster Max wurden als Reviewer hinzugefügt.')).toBe(
      'reviewer-added',
    );
    expect(classifyMail('Muster Max wurde als Reviewer entfernt.')).toBe('reviewer-removed');
    expect(classifyMail('K K hat neue Änderungen mithilfe von Push übertragen.')).toBe('pushed');
    expect(classifyMail('K K hat die automatische Vervollständigung festgelegt.')).toBe(
      'autocomplete-set',
    );
    expect(classifyMail('K K hat die automatische Vervollständigung abgebrochen.')).toBe(
      'autocomplete-cancelled',
    );
    expect(classifyMail('Hallo, kurze Frage zum Release')).toBe('other');
  });

  it('unwraps Safelinks and finds the canonical PR URL', () => {
    expect(parsePrUrl(prLink(4288))).toEqual({
      url: 'https://tfs.example.com/tfs/boom/Produktion/_git/Community/pullrequest/4288',
      host: 'tfs.example.com',
      collection: 'boom',
      project: 'Produktion',
      repo: 'Community',
      id: 4288,
    });
    expect(parsePrUrl('https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7')?.id).toBe(7);
    expect(parsePrUrl('https://tfs.example.com/tfs/boom/Produktion/_git/Community')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });

  it('parses the subject, including titles with dashes', () => {
    expect(
      parseSubject('PR – merge release – service to main – Community 4264 (Kollege Karl)'),
    ).toEqual({
      title: 'merge release – service to main',
      repo: 'Community',
      id: 4264,
      author: 'Kollege Karl',
    });
    expect(parseSubject('Re: Mittagessen')).toBeNull();
  });
});

describe('openPrsFromMails', () => {
  it('keeps open PRs and drops completed ones even if the completion mail came first', () => {
    const mails = [
      // Auto-completed PR: "abgeschlossen" arrives before "erstellt".
      mail(4288, 'Kollege Karl hat den Pull Request abgeschlossen.', T(10)),
      mail(4288, 'Kollege Karl hat einen neuen Pull Request erstellt.', T(11)),
      mail(4290, 'Kollege Karl hat einen neuen Pull Request erstellt.', T(12)),
      mail(4290, 'Kollege Karl hat neue Änderungen mithilfe von Push übertragen.', T(13)),
    ];
    const open = openPrsFromMails({ me: ME, mails });
    expect(open.map((p) => p.meta?.number)).toEqual([4290]);
    expect(open[0]).toMatchObject({
      type: 'pr',
      externalId: 'tfs.example.com/boom/produktion/community/4290',
      link: 'https://tfs.example.com/tfs/boom/Produktion/_git/Community/pullrequest/4290',
      meta: { repo: 'Community', project: 'Produktion', author: 'Kollege Karl' },
    });
  });

  it('handles abandon and reactivation by time', () => {
    const abandoned = [
      mail(1, 'K K hat einen neuen Pull Request erstellt.', T(1)),
      mail(1, 'K K hat den Pull Request aufgegeben.', T(2)),
    ];
    const reactivated = [
      ...abandoned.map((m) => ({
        ...m,
        urls: [prLink(2)],
        subject: m.subject.replace(' 1 ', ' 2 '),
      })),
      { ...mail(2, 'K K hat den Pull Request reaktiviert.', T(3)) },
    ];
    expect(openPrsFromMails({ me: ME, mails: abandoned })).toEqual([]);
    expect(openPrsFromMails({ me: ME, mails: reactivated }).map((p) => p.meta?.number)).toEqual([
      2,
    ]);
  });

  it('tells why a PR is listed: review requested, authored or just notified', () => {
    const mails = [
      mail(10, 'Kollege Karl und Muster Max wurden als Reviewer hinzugefügt.', T(1)),
      mail(11, 'Muster Max hat einen neuen Pull Request erstellt.', T(1), { author: ME }),
      mail(12, 'Muster Max wurde als Reviewer hinzugefügt.', T(1)),
      mail(12, 'Muster Max wurde als Reviewer entfernt.', T(2)),
      mail(13, 'Kollege Karl hat einen neuen Pull Request erstellt.', T(1)),
    ];
    const reasons = Object.fromEntries(
      openPrsFromMails({ me: ME, mails }).map((p) => [p.meta?.number, p.meta?.reasons]),
    );
    expect(reasons).toEqual({
      10: ['review-requested'],
      11: ['authored'],
      12: ['notified'],
      13: ['notified'],
    });
  });

  it('prefers a non-truncated title from the body', () => {
    const long = 'feat: selective counter inheritance via installation structure';
    const [pr] = openPrsFromMails({
      me: ME,
      mails: [mail(5, 'K K hat einen neuen Pull Request erstellt.', T(1), { title: long })],
    });
    expect(pr!.title).toBe(long);
  });

  it('keeps PRs with the same number in different repositories apart', () => {
    const mails = [
      mail(7, 'K K hat einen neuen Pull Request erstellt.', T(1), { repo: 'Community' }),
      mail(7, 'K K hat einen neuen Pull Request erstellt.', T(1), { repo: 'Swietelsky' }),
    ];
    expect(openPrsFromMails({ me: ME, mails })).toHaveLength(2);
  });

  it('falls back to the subject when no PR link is present and ignores unrelated mails', () => {
    const noLink = { ...mail(9, 'K K hat einen neuen Pull Request erstellt.', T(1)), urls: [] };
    const unrelated: PrMail = {
      receivedAt: T(1),
      subject: 'Mittagessen?',
      body: 'Hunger',
      urls: [],
    };
    const open = openPrsFromMails({ me: ME, mails: [noLink, unrelated] });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ externalId: 'subject/community/9', link: null });
  });
});

describe('mail source via sync', () => {
  it('adds open PRs and removes them once the completion mail arrives', async () => {
    const mails: PrMail[] = [
      mail(4290, 'Kollege Karl und Muster Max wurden als Reviewer hinzugefügt.', T(9)),
    ];
    const folders: string[] = [];
    const core = makeCore({
      secrets: new MemorySecretStore(),
      mailboxReader: async ({ folderPath }) => {
        folders.push(folderPath);
        return { me: ME, mails: structuredClone(mails) };
      },
    });
    core.fakeClock.set(T(12));
    core.settings.update({
      github: { enabled: false },
      calendar: { enabled: false },
      mail: { enabled: true, outlookFolder: 'Posteingang/PR' },
    });
    try {
      expect(core.sourceStatus().mail).toBe('ready');
      const first = await core.syncAll();
      expect(first.results).toMatchObject([{ source: 'mail', ok: true, added: 1 }]);
      expect(folders).toEqual(['Posteingang/PR']);
      const [pr] = core.items.list({ type: 'pr' });
      expect(pr).toMatchObject({ source: 'mail', meta: { reasons: ['review-requested'] } });

      // Idempotent while nothing changes.
      expect((await core.syncAll()).results).toMatchObject([{ added: 0, updated: 0, closed: 0 }]);

      core.fakeClock.advance(HOUR);
      mails.push(mail(4290, 'Kollege Karl hat den Pull Request abgeschlossen.', T(12)));
      expect((await core.syncAll()).results).toMatchObject([{ closed: 1 }]);
      expect(core.items.get(pr!.id)).toMatchObject({ status: 'done', statusChangedBy: 'sync' });
      expect(core.items.list({ type: 'pr' })).toEqual([]);
    } finally {
      core.close();
    }
  });

  it('closes nothing when Outlook cannot be read', async () => {
    let fail = false;
    const core = makeCore({
      mailboxReader: async () => {
        if (fail) throw new Error('Outlook folder "Posteingang/PR" could not be read');
        return { me: ME, mails: [mail(1, 'K K hat einen neuen Pull Request erstellt.', T(9))] };
      },
    });
    core.fakeClock.set(T(12));
    core.settings.update({
      github: { enabled: false },
      calendar: { enabled: false },
      mail: { enabled: true },
    });
    try {
      await core.syncAll();
      fail = true;
      const r = await core.syncAll();
      expect(r.results[0]).toMatchObject({ ok: false, closed: 0 });
      expect(core.items.list({ type: 'pr' })).toHaveLength(1);
    } finally {
      core.close();
    }
  });

  it('ignores mails older than the look-back window', async () => {
    const core = makeCore({
      mailboxReader: async () => ({
        me: ME,
        mails: [mail(1, 'K K hat einen neuen Pull Request erstellt.', T(1))],
      }),
    });
    core.fakeClock.set(new Date(Date.parse(T(1)) + 100 * 24 * HOUR));
    core.settings.update({
      github: { enabled: false },
      calendar: { enabled: false },
      mail: { enabled: true, lookBackDays: 90 },
    });
    try {
      expect((await core.syncAll()).results[0]).toMatchObject({ ok: true, added: 0 });
    } finally {
      core.close();
    }
  });
});
