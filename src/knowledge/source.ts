/**
 * What a knowledge request takes from its source note: the sentence(s) around
 * the highlight (the evidence), the heading it sits under (for a link back),
 * and the concept the highlight names.
 */

export interface SourceExcerpt {
  /** The sentence(s) containing the highlight, with the highlight in **bold**. */
  excerpt: string;
  /** The nearest heading above the highlight, for `[[Note#Heading]]`; null before the first heading. */
  heading: string | null;
}

const MAX_EXCERPT = 600;
const HEADING = /^#{1,6}\s+(.*)$/;

/** Where the sentence containing `at` starts, not crossing a blank line, a heading or a list item. */
function sentenceStart(doc: string, at: number): number {
  for (let i = at - 1; i >= 0; i--) {
    const ch = doc[i];
    if (ch === '\n') {
      const next = doc.slice(i + 1, at);
      if (doc[i - 1] === '\n' || /^\s*([-*+]|\d+[.)]|#)/.test(next) || HEADING.test(doc.slice(doc.lastIndexOf('\n', i - 1) + 1, i))) return i + 1;
    }
    if (/[.!?]/.test(ch) && /\s/.test(doc[i + 1] ?? '')) return i + 1;
  }
  return 0;
}

function sentenceEnd(doc: string, at: number): number {
  for (let i = at; i < doc.length; i++) {
    const ch = doc[i];
    if (/[.!?]/.test(ch) && (i + 1 >= doc.length || /\s/.test(doc[i + 1]))) return i + 1;
    if (ch === '\n' && (doc[i + 1] === '\n' || /^\s*([-*+]|\d+[.)]|#)/.test(doc.slice(i + 1, i + 12)))) return i;
  }
  return doc.length;
}

export function excerptAround(doc: string, from: number, to: number): SourceExcerpt {
  let start = sentenceStart(doc, from);
  let end = sentenceEnd(doc, Math.max(to, from));
  if (end - start > MAX_EXCERPT) {
    start = Math.max(start, from - MAX_EXCERPT / 2);
    end = Math.min(end, to + MAX_EXCERPT / 2);
  }
  const lead = doc.slice(start, from).replace(/^\s+/, '');
  const tail = doc.slice(to, end).replace(/\s+$/, '');
  const highlight = doc.slice(from, to).trim();
  const excerpt = `${lead}**${highlight}**${tail}`.replace(/\s*\n\s*/g, ' ').trim();
  let heading: string | null = null;
  let fenced = false;
  for (const line of doc.slice(0, from).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m) heading = m[1].replace(/[#[\]|^]/g, '').trim();
  }
  return { excerpt, heading };
}

const MAX_SECTION = 3000;

/**
 * The text under the nearest heading above `at` (of any level) up to the next
 * heading: the part of the note the highlight belongs to, never the whole note
 * just because it sits under a top-level title.
 */
export function localSection(doc: string, at: number): { label: string; text: string } {
  const lines = doc.split('\n');
  let pos = 0;
  let start = 0;
  let title: string | null = null;
  let end = doc.length;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m && pos <= at) {
      start = pos;
      title = m[1].trim();
    } else if (m && pos > at) {
      end = pos;
      break;
    }
    pos += line.length + 1;
  }
  let text = doc.slice(start, end).trim();
  if (text.length > MAX_SECTION) {
    const from = Math.max(0, at - start - MAX_SECTION / 2);
    text = `[…]${text.slice(from, from + MAX_SECTION)}[…]`;
  }
  return { label: title ? `The section “${title}”` : 'The text around it', text };
}

const stem = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 4);

/**
 * The concept's name. A short highlight names the concept: when the model's
 * title shares no word with it (it named the note or the section instead), the
 * highlight itself becomes the title, and the model's title an alias.
 */
export function conceptTitle(title: string, quote: string | null, noteName: string): { title: string; alias: string | null } {
  const words = (quote ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return { title, alias: null };
  const quoteStems = new Set(words.map(stem).filter((s) => s.length >= 3));
  const shares = title.split(/\s+/).some((w) => quoteStems.has(stem(w)));
  const isNote = title.trim().toLowerCase() === noteName.trim().toLowerCase();
  if (shares && !isNote) return { title, alias: null };
  const phrase = words.join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!phrase) return { title, alias: null };
  return { title: phrase.charAt(0).toUpperCase() + phrase.slice(1), alias: isNote ? null : title };
}
