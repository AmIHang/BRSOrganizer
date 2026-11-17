import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BsmLoginRequiredError,
  bsmDocumentRequest,
  bsmKey,
  ticketMarkdown,
  bsmTicketRequest,
  parseBsmTicket,
  readBsmTicket,
  type BsmHttp,
  type BsmSession,
} from '../src/tickets/bsm.js';
import { htmlToText } from '../src/tickets/html.js';
import { makeCore } from '../../core/test/helpers.js';
import {
  fillBsmFromOtma,
  otmaBsmKey,
  otmaJumpRequest,
  otmaKey,
  otmaViewRequest,
  parseOtmaTicket,
  readOtmaTicket,
} from '../src/tickets/otma.js';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'bsm-indication.json'), 'utf8'),
) as unknown;

const NOW = new Date('2026-11-16T13:02:00Z');

describe('htmlToText', () => {
  const noImg = () => '[img]';

  it('keeps paragraphs, line breaks, lists, headings and links readable', () => {
    expect(
      htmlToText(
        '<p>Eins<br />\nzwei</p>\n<ul>\n<li>a</li>\n<li>b &amp; c</li>\n</ul><h2 id="x">Titel</h2>' +
          '<p><a href="https://x.example/v">Versionen</a> <a href="https://y.example">https://y.example</a></p>',
        noImg,
      ),
    ).toBe(
      'Eins\nzwei\n\n- a\n- b & c\n\n## Titel\n\nVersionen (https://x.example/v) https://y.example',
    );
  });

  it('replaces images and drops scripts and comments', () => {
    expect(
      htmlToText(
        '<p>x<img src="abc" alt="a.png" /><script>alert(1)</script><!-- c --></p>',
        (s, a) => `[${s}|${a}]`,
      ),
    ).toBe('x[abc|a.png]');
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('&#252;ber &#x2013; &quot;x&quot;&nbsp;y', noImg)).toBe('über – "x" y');
  });
});

describe('BSM ticket', () => {
  it('accepts only ticket URLs on the BSM host', () => {
    expect(bsmKey('https://bsm.boomsoftware.com/indication/BRS_PWg0127')).toBe('BRS_PWg0127');
    expect(bsmKey('https://evil.example/indication/BRS_PWg0127')).toBeNull();
    expect(bsmKey('http://bsm.boomsoftware.com/indication/BRS_PWg0127')).toBeNull();
    expect(bsmKey('https://bsm.boomsoftware.com/other/BRS_PWg0127')).toBeNull();
    expect(bsmKey('kein Link')).toBeNull();
  });

  it('requests the ticket by its key in the context path', () => {
    expect(bsmTicketRequest('BRS_PWg0122')).toEqual({
      ContextOPath:
        '|BRS_PWg0122|@BoomSupportManager.UI.IndicationIdentifier,BoomSupportManager.Core',
      WorkflowType: 'External',
      WorkflowName: 'JumpToIndication',
      WorkflowParameters: { publicurl: 'indication/BRS_PWg0122' },
    });
  });

  it('extracts the fields, description, deliveries, comments and images', () => {
    const t = parseBsmTicket(fixture, 'BRS_PWg0155');
    expect(t.title).toBe('IH-Berechnung | Termine werden nicht zusammengelegt');
    expect(t.fields).toEqual([
      ['Status', 'In Bearbeitung'],
      ['Kategorie', 'Fehlermeldung/Schwerer Fehler, Workaround umständlich'],
      ['Priorität', 'Hoch'],
      ['Melder', 'Muster Max'],
      ['Verantwortlich', 'Beispiel Eva'],
      ['Betroffenes System', 'BRS Produktwartung & Support, BRS Produktwartung'],
      ['Bereich', 'Rail Asset'],
      ['Tags', 'BRS 1.7.0'],
      ['Erstellt', 'Erstellt von Muster Max am 03.11.2026 09:56'],
      ['Geändert', 'Geändert von Beispiel Eva am 10.11.2026 13:41'],
    ]);
    expect(t.description).toContain('Termine werden nicht zusammengelegt.\n[Bild 1: image.png]');
    expect(t.description).toContain('- W4: alle 1000 h');
    expect(t.description).toContain('## Erwartet: Termine werden inkludiert & zusammengelegt.');
    expect(t.deliveries).toEqual(['geplant – Release: 1.9.1 (08.01.2027), Status: Geplant']);
    expect(t.notes).toEqual([]);
    expect(t.conversations).toHaveLength(1);
    const [first, second] = t.conversations[0]!.comments;
    expect(first).toMatchObject({
      author: 'Muster Max',
      text: 'Können wir hier bitte eine Info bekommen?\n\nDer Kunde drängt.',
    });
    expect(second!.author).toBe('Beispiel Eva');
    expect(second!.text).toBe(
      'Muster Max\nGilt die Entscheidung aus 2024 noch?\n[Bild 2: vergleich.png]',
    );
    expect(second!.answers.map((a) => [a.author, a.text])).toEqual([
      ['Muster Max', 'Ja, gilt weiterhin.'],
    ]);
    expect(t.images).toEqual([
      { n: 1, id: '11111111-1111-1111-1111-111111111111', fileName: 'image.png' },
      { n: 2, id: '22222222-2222-2222-2222-222222222222', fileName: 'vergleich.png' },
    ]);
    // Document list; rows without a valid object path are ignored.
    expect(t.attachments).toEqual([
      {
        opath: '*r6WfLsls',
        name: 'image',
        type: 'PNG-Datei',
        author: 'Muster Max',
        at: new Date(1793696217715),
      },
      {
        opath: '*pdfRow01',
        name: 'Screenshot 2026-06-29 094931',
        type: 'PNG-Datei',
        author: 'Beispiel Eva',
        at: new Date(1782719393744),
      },
    ]);

    // No UI internals in what the agent gets.
    const md = ticketMarkdown(t, NOW);
    expect(md).not.toMatch(/opath|contextopath|signature|example\.com\/?"|@example|menus/i);
  });

  it('renders Markdown for the prompt', () => {
    const t = parseBsmTicket(fixture, 'BRS_PWg0155');
    const md = ticketMarkdown(t, NOW, {
      images: new Map([[1, 'C:\\tmp\\bsm-1-image.png']]),
      attachments: [{ attachment: t.attachments[1]!, file: 'C:\\tmp\\anhang-1-shot.png' }],
    });
    expect(md.split('\n').slice(0, 6)).toEqual([
      '### BSM-Ticket BRS_PWg0155: IH-Berechnung | Termine werden nicht zusammengelegt',
      '',
      'Quelle: https://bsm.boomsoftware.com/indication/BRS_PWg0155 (abgerufen 16.11.2026 14:02)',
      '',
      '- Status: In Bearbeitung',
      '- Kategorie: Fehlermeldung/Schwerer Fehler, Workaround umständlich',
    ]);
    expect(md).toContain('- Lieferung geplant – Release: 1.9.1 (08.01.2027), Status: Geplant');
    expect(md).toContain(
      '- Beispiel Eva, 10.11.2026 13:38:\n  Muster Max\n  Gilt die Entscheidung',
    );
    expect(md).toContain('  - Muster Max, 11.11.2026 14:35:\n    Ja, gilt weiterhin.');
    expect(md).toContain('- Bild 1 (image.png): C:\\tmp\\bsm-1-image.png');
    expect(md).toContain('- Bild 2 (vergleich.png): nicht heruntergeladen');
    expect(md).toContain(
      '#### Anhänge\n\n- Anhang 1 (Screenshot 2026-06-29 094931; PNG-Datei, Beispiel Eva, 29.06.2026 09:49): C:\\tmp\\anhang-1-shot.png',
    );
  });

  it('rejects responses that are not a ticket form', () => {
    expect(() => parseBsmTicket({ link: {} }, 'X1')).toThrow(/unerwartete Antwort/);
  });
});

describe('readBsmTicket', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'brsorganizer-bsm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sessionWith =
    (http: BsmHttp): BsmSession =>
    (fn) =>
      fn(http);

  it('reads the ticket and saves its images and attachments next to the prompt', async () => {
    const requests: unknown[] = [];
    const downloads: string[] = [];
    const tokens: Record<string, string> = {
      '*r6WfLsls': 'token-image-0001',
      '*pdfRow01': 'token-shot-00001',
    };
    const http: BsmHttp = {
      runWorkflow: async (body) => {
        requests.push(body);
        const token = tokens[(body as { ContextOPath: string }).ContextOPath];
        return token ? { download: token, download_fileextension: '.png' } : fixture;
      },
      download: async (path) => {
        downloads.push(path);
        if (path.includes('2222')) throw new Error('404');
        // The document list repeats image 1 (same bytes) and has one real attachment.
        return path.endsWith('token-shot-00001')
          ? new Uint8Array([9, 9])
          : new Uint8Array([1, 2, 3]);
      },
    };
    const r = await readBsmTicket(
      sessionWith(http),
      'https://bsm.boomsoftware.com/indication/BRS_PWg0155',
      dir,
      () => NOW,
    );
    expect(requests).toEqual([
      bsmTicketRequest('BRS_PWg0155'),
      bsmDocumentRequest('*r6WfLsls'),
      bsmDocumentRequest('*pdfRow01'),
    ]);
    // Read-only: "Öffnen" without a transaction.
    expect(bsmDocumentRequest('*x')).toMatchObject({
      WorkflowType: 'View',
      TransactionBehavior: 'NoTransaction',
    });
    expect(downloads).toEqual([
      '/bfres/de/referenced-document/11111111-1111-1111-1111-111111111111/image.png',
      '/bfres/de/referenced-document/22222222-2222-2222-2222-222222222222/vergleich.png',
      '/api/core/web/dl/token-image-0001',
      '/api/core/web/dl/token-shot-00001',
    ]);
    const shot = join(dir, 'anhang-1-Screenshot_2026-06-29_094931.png');
    expect(r.files).toEqual([join(dir, 'bsm-1-image.png'), shot]);
    expect(existsSync(r.files[0]!)).toBe(true);
    expect(readFileSync(shot)).toEqual(Buffer.from([9, 9]));
    expect(r.markdown).toContain(`- Bild 1 (image.png): ${join(dir, 'bsm-1-image.png')}`);
    expect(r.markdown).toContain('- Bild 2 (vergleich.png): nicht heruntergeladen');
    // The copy of image 1 in the document list is not listed again.
    expect(r.markdown).toContain(
      `- Anhang 1 (Screenshot 2026-06-29 094931; PNG-Datei, Beispiel Eva, 29.06.2026 09:49): ${shot}`,
    );
    expect(r.markdown).not.toContain('Anhang 2');
  });

  it('never contacts other hosts and passes a missing login on', async () => {
    const http: BsmHttp = {
      runWorkflow: async () => {
        throw new BsmLoginRequiredError();
      },
      download: async () => new Uint8Array(),
    };
    await expect(
      readBsmTicket(
        sessionWith(http),
        'https://evil.example/indication/BRS_PWg0155',
        dir,
        () => NOW,
      ),
    ).rejects.toThrow(/keine Ticket-URL/);
    await expect(
      readBsmTicket(
        sessionWith(http),
        'https://bsm.boomsoftware.com/indication/BRS_PWg0155',
        dir,
        () => NOW,
      ),
    ).rejects.toBeInstanceOf(BsmLoginRequiredError);
  });
});

describe('OTMA ticket', () => {
  const otmaFixture = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'otma-order-process.json'), 'utf8'),
  ) as unknown;
  const jump = {
    link: {
      wf: {
        contextopath: '2B89D@1000A5',
        entity: 'dotNetBF.Modules.Resources.OrderProcess',
        type: 'View',
        args: { formname: 'from-project' },
      },
      target: '_self',
    },
  };

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'brsorganizer-otma-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts only ticket URLs on the OTMA host', () => {
    expect(otmaKey('https://otma.boomsoftware.com/ap/178333')).toBe('178333');
    expect(otmaKey('https://evil.example/ap/178333')).toBeNull();
    expect(otmaKey('https://otma.boomsoftware.com/ap/abc')).toBeNull();
    expect(otmaKey('kein Link')).toBeNull();
  });

  it('follows the jump answer to the ticket view only', () => {
    expect(otmaViewRequest(jump)).toEqual({
      ContextOPath: '2B89D@1000A5',
      WorkflowEntity: 'dotNetBF.Modules.Resources.OrderProcess',
      WorkflowType: 'View',
      WorkflowParameters: { formname: 'from-project' },
    });
    // Anything but the order process view (another entity, a non-view workflow) is refused.
    const other = structuredClone(jump);
    other.link.wf.type = 'External';
    expect(() => otmaViewRequest(other)).toThrow(/OTMA/);
    expect(() => otmaViewRequest({ ui: {} })).toThrow(/OTMA/);
  });

  it('extracts the fields, note, comments and images', () => {
    const t = parseOtmaTicket(otmaFixture, '178333');
    expect(t.system).toBe('OTMA');
    expect(t.url).toBe('https://otma.boomsoftware.com/ap/178333');
    expect(t.title).toBe(
      '#STBBRSg0034: [WORKSHOP] Vordefinierte E-Mailempfänger werden nicht angeführt',
    );
    expect(t.fields).toEqual([
      ['Status', 'Zugewiesen'],
      ['Verantwortlich', 'ABC -> XYZ'],
      ['Reporter', 'Muster Max'],
      ['Projekt', 'STB BRS [STBBRS]'],
      ['BSM', 'STBBRSg0034'],
      ['Planzeit h', '2,00'],
      ['Offen h', '1,00'],
      ['Σ Ist h', '1,00'],
    ]);
    expect(t.description).toBe('Empfänger aus der Vorlage fehlen im Dialog.');
    expect(t.notes).toEqual(['Nur bei Workshop-Terminen.']);
    expect(t.conversations).toEqual([
      {
        topic: 'Analyse',
        comments: [
          {
            author: 'Beispiel Eva',
            at: new Date(1794212613789),
            text: 'Siehe Screenshot:\n\n[Bild 1: dialog.png]',
            answers: [],
          },
          {
            author: 'BRS Support',
            at: new Date(1794299013789),
            text: 'Commit 1df970e',
            answers: [],
          },
        ],
      },
    ]);
    expect(t.images).toEqual([
      { n: 1, id: '33333333-3333-3333-3333-333333333333', fileName: 'dialog.png' },
    ]);
  });

  it('reads the ticket in two steps and saves its images', async () => {
    const requests: unknown[] = [];
    const downloads: string[] = [];
    const http: BsmHttp = {
      runWorkflow: async (body) => {
        requests.push(body);
        return requests.length === 1 ? jump : otmaFixture;
      },
      download: async (path) => {
        downloads.push(path);
        return new Uint8Array([7]);
      },
    };
    const r = await readOtmaTicket(
      (fn) => fn(http),
      'https://otma.boomsoftware.com/ap/178333',
      dir,
      () => NOW,
    );
    expect(requests).toEqual([otmaJumpRequest('178333'), otmaViewRequest(jump)]);
    expect(downloads).toEqual([
      '/bfres/de/referenced-document/33333333-3333-3333-3333-333333333333/dialog.png',
    ]);
    expect(r.files).toEqual([join(dir, 'otma-1-dialog.png')]);
    expect(r.markdown.split('\n').slice(0, 3)).toEqual([
      '### OTMA-Ticket 178333: #STBBRSg0034: [WORKSHOP] Vordefinierte E-Mailempfänger werden nicht angeführt',
      '',
      'Quelle: https://otma.boomsoftware.com/ap/178333 (abgerufen 16.11.2026 14:02)',
    ]);
    expect(r.markdown).toContain('- Beispiel Eva, 09.11.2026 09:23:');
    expect(r.markdown).toContain(`- Bild 1 (dialog.png): ${join(dir, 'otma-1-dialog.png')}`);
  });

  it('never contacts other hosts and passes a missing login on', async () => {
    const http: BsmHttp = {
      runWorkflow: async () => {
        throw new BsmLoginRequiredError('OTMA');
      },
      download: async () => new Uint8Array(),
    };
    await expect(
      readOtmaTicket(
        (fn) => fn(http),
        'https://evil.example/ap/1',
        dir,
        () => NOW,
      ),
    ).rejects.toThrow(/keine Ticket-URL/);
    await expect(
      readOtmaTicket(
        (fn) => fn(http),
        'https://otma.boomsoftware.com/ap/1',
        dir,
        () => NOW,
      ),
    ).rejects.toThrow('OTMA: nicht angemeldet');
  });
});

describe('BSM ticket from OTMA', () => {
  const view = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'otma-order-process.json'), 'utf8'),
  ) as { ui: { form: unknown[] } };
  const jump = {
    link: {
      wf: {
        contextopath: '2B89D@1000A5',
        entity: 'dotNetBF.Modules.Resources.OrderProcess',
        type: 'View',
        args: { formname: 'from-project' },
      },
    },
  };
  const withBsm = (value: string) =>
    JSON.parse(JSON.stringify(view).replace('"value":"STBBRSg0034"', `"value":"${value}"`));

  it('takes the key from the BSM field and ignores the placeholder', () => {
    expect(otmaBsmKey(view)).toBe('STBBRSg0034');
    expect(otmaBsmKey(withBsm('Kein Ticket zugewiesen'))).toBeNull();
  });

  it('fills a new todo with an OTMA but no BSM ticket, and nothing else', async () => {
    const core = makeCore();
    const reads: string[] = [];
    const session: BsmSession = (fn) =>
      fn({
        runWorkflow: async (body) => {
          const b = body as { WorkflowName?: string; WorkflowParameters: { publicurl?: string } };
          if (b.WorkflowName) reads.push(b.WorkflowParameters.publicurl!);
          return b.WorkflowName ? jump : view;
        },
        download: async () => new Uint8Array(),
      });
    fillBsmFromOtma(core, session);
    const settle = () => new Promise((r) => setTimeout(r, 10));

    const todo = core.items.addTodo({ title: 'A', otmaUrl: '165071' }, 'claude');
    const own = core.items.addTodo({ title: 'B', otmaUrl: '1', bsmUrl: 'X_1' }, 'user');
    core.items.addTodo({ title: 'C' }, 'user');
    await settle();
    expect(reads).toEqual(['ap/165071']);
    expect(core.items.get(todo.id)).toMatchObject({
      bsmUrl: 'https://bsm.boomsoftware.com/indication/STBBRSg0034',
      updatedBy: 'claude',
    });
    expect(core.items.get(own.id).bsmUrl).toBe('https://bsm.boomsoftware.com/indication/X_1');

    // Set by the user while OTMA was read: stays.
    let release!: () => void;
    const slow: BsmSession = async (fn) => {
      await new Promise<void>((r) => (release = r));
      return session(fn);
    };
    const core2 = makeCore();
    fillBsmFromOtma(core2, slow);
    const t2 = core2.items.addTodo({ title: 'D', otmaUrl: '2' }, 'user');
    core2.items.setTickets(t2.id, { bsmUrl: 'Y_2' }, 'user');
    release();
    await settle();
    expect(core2.items.get(t2.id).bsmUrl).toBe('https://bsm.boomsoftware.com/indication/Y_2');
  });
});
