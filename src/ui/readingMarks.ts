import { findImageEmbeds } from '../anchor/imageEmbed';
import type { ThreadView } from './viewModel';

/** A found anchor, in source offsets of the whole note. */
export interface ReadingMark {
  threadId: string;
  quote: string;
  from: number;
  number: number;
  resolved: boolean;
  /** For image threads: the embed's link as written, which Reading view keeps in the embed's `src`. */
  imageLink?: string;
}

/** Marks for the found anchors of a note whose current source is `doc`. */
export function readingMarks(views: ThreadView[], doc: string): ReadingMark[] {
  return views.flatMap((v): ReadingMark[] => {
    if (v.anchor.kind !== 'found' || v.quote === null) return [];
    const mark: ReadingMark = {
      threadId: v.thread.id,
      quote: doc.slice(v.anchor.from, v.anchor.to),
      from: v.anchor.from,
      number: v.number,
      resolved: v.thread.status === 'resolved',
    };
    if (v.imagePath !== null) {
      const [embed] = findImageEmbeds(mark.quote);
      if (!embed) return [];
      mark.imageLink = embed.link;
    }
    return [mark];
  });
}

/** Offset of the first character of `line` (0-based) in `text`. */
export function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

function countBefore(haystack: string, needle: string, end: number): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1 && at < end) {
    n++;
    at = haystack.indexOf(needle, at + 1);
  }
  return n;
}

/**
 * Highlights anchored passages inside one rendered Reading-view section.
 *
 * The section's source tells us which occurrence of the quote the anchor is
 * (the 1st, 2nd… inside this section); the same occurrence is then wrapped in
 * the rendered text. Rendering strips Markdown syntax, so a quote that spans
 * formatting (for example half bold) cannot be matched in one text node and is
 * left unhighlighted rather than guessed. Returns how many passages were marked.
 */
export function markRenderedSection(
  el: HTMLElement,
  source: string,
  sectionStart: number,
  sectionEnd: number,
  marks: ReadingMark[],
  onOpen: (threadId: string) => void,
): number {
  let marked = 0;
  const section = source.slice(sectionStart, sectionEnd);
  // Last passage first: wrapping one never shifts the occurrence count of a passage still to come.
  for (const mark of [...marks].sort((a, b) => b.from - a.from)) {
    if (mark.from < sectionStart || mark.from >= sectionEnd) continue;
    if (mark.imageLink !== undefined) {
      if (markImage(el, section, mark, sectionStart, onOpen)) marked++;
      continue;
    }
    const occurrence = countBefore(section, mark.quote, mark.from - sectionStart);
    if (wrapOccurrence(el, mark, occurrence, onOpen)) marked++;
  }
  return marked;
}

/**
 * Wiki embeds render as `.internal-embed[src="<link>"]`; the anchor's embed is
 * the same-numbered one with that link in this section. Markdown-style image
 * embeds keep no link in the DOM, so they are not badged in Reading view.
 */
function markImage(el: HTMLElement, section: string, mark: ReadingMark, sectionStart: number, onOpen: (id: string) => void): boolean {
  const occurrence = findImageEmbeds(section).filter(
    (e) => e.link === mark.imageLink && e.from < mark.from - sectionStart,
  ).length;
  const matches = [...el.querySelectorAll<HTMLElement>('.internal-embed[src]')].filter(
    (e) => e.getAttribute('src')!.split('|')[0].split('#')[0].trim() === mark.imageLink,
  );
  const target = matches[occurrence];
  if (!target || target.classList.contains('tg-image-anchor')) return false;
  target.classList.add('tg-image-anchor');
  target.setAttribute('data-tg-thread', mark.threadId);
  target.after(badge(mark, onOpen));
  return true;
}

/** Text nodes in document order, skipping ones already inside a Threadglyph mark. */
function textNodes(root: Node, out: Text[] = []): Text[] {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out.push(child as Text);
    else if (child instanceof Element && !child.matches('.tg-anchor, .tg-badge')) textNodes(child, out);
  }
  return out;
}

function wrapOccurrence(el: HTMLElement, mark: ReadingMark, occurrence: number, onOpen: (id: string) => void): boolean {
  let seen = 0;
  for (const node of textNodes(el)) {
    let at = node.data.indexOf(mark.quote);
    while (at !== -1) {
      if (seen === occurrence) {
        wrap(node, at, mark, onOpen);
        return true;
      }
      seen++;
      at = node.data.indexOf(mark.quote, at + 1);
    }
  }
  return false;
}

function wrap(node: Text, at: number, mark: ReadingMark, onOpen: (id: string) => void): void {
  const target = node.splitText(at);
  const rest = target.splitText(mark.quote.length);
  const span = document.createElement('span');
  span.className = mark.resolved ? 'tg-anchor tg-anchor-resolved' : 'tg-anchor';
  span.setAttribute('data-tg-thread', mark.threadId);
  target.replaceWith(span);
  span.appendChild(target);

  span.addEventListener('click', () => onOpen(mark.threadId));
  rest.parentNode!.insertBefore(badge(mark, onOpen), rest);
}

function badge(mark: ReadingMark, onOpen: (id: string) => void): HTMLElement {
  const el = document.createElement('span');
  el.className = mark.resolved ? 'tg-badge tg-badge-resolved' : 'tg-badge';
  el.textContent = String(mark.number);
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `Open thread ${mark.number}`);
  const open = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    onOpen(mark.threadId);
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') open(e);
  });
  return el;
}
