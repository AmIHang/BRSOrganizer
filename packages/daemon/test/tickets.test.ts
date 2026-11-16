import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BsmLoginRequiredError,
  bsmKey,
  bsmTicketMarkdown,
  bsmTicketRequest,
  parseBsmTicket,
  readBsmTicket,
  type BsmHttp,
  type BsmSession,
} from '../src/tickets/bsm.js';
import { htmlToText } from '../src/tickets/html.js';

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

    // No UI internals in what the agent gets.
    const md = bsmTicketMarkdown(t, NOW);
    expect(md).not.toMatch(/opath|contextopath|signature|example\.com\/?"|@example|menus/i);
  });

  it('renders Markdown for the prompt', () => {
    const md = bsmTicketMarkdown(
      parseBsmTicket(fixture, 'BRS_PWg0155'),
      NOW,
      new Map([[1, 'C:\\tmp\\bsm-1-image.png']]),
    );
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

  it('reads the ticket and saves its images next to the prompt', async () => {
    const requests: unknown[] = [];
    const downloads: string[] = [];
    const http: BsmHttp = {
      runWorkflow: async (body) => {
        requests.push(body);
        return fixture;
      },
      download: async (path) => {
        downloads.push(path);
        if (path.includes('2222')) throw new Error('404');
        return new Uint8Array([1, 2, 3]);
      },
    };
    const r = await readBsmTicket(
      sessionWith(http),
      'https://bsm.boomsoftware.com/indication/BRS_PWg0155',
      dir,
      () => NOW,
    );
    expect(requests).toEqual([bsmTicketRequest('BRS_PWg0155')]);
    expect(downloads).toEqual([
      '/bfres/de/referenced-document/11111111-1111-1111-1111-111111111111/image.png',
      '/bfres/de/referenced-document/22222222-2222-2222-2222-222222222222/vergleich.png',
    ]);
    expect(r.files).toEqual([join(dir, 'bsm-1-image.png')]);
    expect(existsSync(r.files[0]!)).toBe(true);
    expect(r.markdown).toContain(`- Bild 1 (image.png): ${join(dir, 'bsm-1-image.png')}`);
    expect(r.markdown).toContain('- Bild 2 (vergleich.png): nicht heruntergeladen');
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
