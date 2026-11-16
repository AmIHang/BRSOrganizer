const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/**
 * Plain text from the rich-text HTML of a ticket (editor output: p, br, lists, headings, links,
 * images, tables). Images are replaced by what `image(src, alt)` returns.
 */
export function htmlToText(html: string, image: (src: string, alt: string) => string): string {
  let s = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
    // Source line breaks are not text line breaks; <br> and blocks are.
    .replace(/\n/g, ' ');

  s = s.replace(/<img\b[^>]*>/gi, (tag) => image(attr(tag, 'src') ?? '', attr(tag, 'alt') ?? ''));
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const href = attr(attrs, 'href');
    const text = inner.replace(/<[^>]+>/g, '').trim();
    return href && /^https?:/i.test(href) && decodeEntities(text) !== href
      ? `${inner} (${href})`
      : inner;
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n---\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|blockquote|pre)>/gi, '\n')
    .replace(/<(p|div|ul|ol|table|tr|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(s)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
