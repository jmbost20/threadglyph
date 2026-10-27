import { SCHEMA_VERSION, type TextAnchor } from '../model/types';

/** Characters of surrounding context captured on each side of a quote. */
export const CONTEXT_CHARS = 64;

/**
 * A text quote shorter than this (in characters) is only trusted at a single
 * match when some of its saved context still surrounds it. A single word
 * easily appears again elsewhere; a longer passage is distinctive on its own,
 * so it keeps following the text when a paragraph is moved.
 */
export const SHORT_QUOTE_CHARS = 40;

export type AnchorResolution =
  | { status: 'found'; from: number; to: number }
  | { status: 'ambiguous'; candidates: number[] }
  /** A short quote occurs once, but none of its saved context is around it: likely a different copy. */
  | { status: 'unconfirmed'; at: number }
  | { status: 'missing' };

export function lineOf(doc: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < doc.length; i++) if (doc[i] === '\n') line++;
  return line;
}

export function captureTextAnchor(
  threadId: string,
  notePath: string,
  doc: string,
  from: number,
  to: number,
): TextAnchor {
  if (from < 0 || to > doc.length || from >= to) throw new RangeError('Selection is outside the note.');
  const quote = doc.slice(from, to);
  if (!quote.trim()) throw new RangeError('Select some text to comment on.');
  return {
    schema: SCHEMA_VERSION,
    threadId,
    kind: 'text',
    notePath,
    quote,
    prefix: doc.slice(Math.max(0, from - CONTEXT_CHARS), from),
    suffix: doc.slice(to, to + CONTEXT_CHARS),
    lineHint: lineOf(doc, from),
  };
}

function occurrences(doc: string, quote: string): number[] {
  const found: number[] = [];
  let at = doc.indexOf(quote);
  while (at !== -1) {
    found.push(at);
    at = doc.indexOf(quote, at + 1);
  }
  return found;
}

/** Length of the shared run ending at `docEnd` in doc and at the end of `prefix`. */
function sharedBefore(doc: string, docEnd: number, prefix: string): number {
  let n = 0;
  while (n < prefix.length && docEnd - n - 1 >= 0 && doc[docEnd - n - 1] === prefix[prefix.length - n - 1]) n++;
  return n;
}

/** Length of the shared run starting at `docStart` in doc and at the start of `suffix`. */
function sharedAfter(doc: string, docStart: number, suffix: string): number {
  let n = 0;
  while (n < suffix.length && docStart + n < doc.length && doc[docStart + n] === suffix[n]) n++;
  return n;
}

/** Letters and digits that must surround a short quote's single match for it to count as the same place. */
const MIN_SHARED_WORD_CHARS = 3;

const wordChars = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

/** Formatting marks that wrap a passage without changing where it is: bold, italic, highlight, strikethrough, links. */
const MARKS_BEFORE = '*_=~[';
const MARKS_AFTER = '*_=~]';

/** Where markup in front of `at` begins (`{==` and formatting marks such as `**` or `[[`), or `at` when there is none. */
function markupStart(text: string, at: number): number {
  // Comment markup and formatting marks can nest in either order (`{==**`, `**{==`).
  let start = at;
  for (;;) {
    if (start >= 3 && text.startsWith('{==', start - 3)) start -= 3;
    else if (start > 0 && MARKS_BEFORE.includes(text[start - 1])) start--;
    else return start;
  }
}

/**
 * Where markup after `at` ends (`==}{>>…<<}…` and formatting marks such as `**` or `]]`), or `at` when
 * there is none. A cut-off comment runs to the end.
 */
function markupEnd(text: string, at: number): number {
  // Comment markup and formatting marks can nest in either order (`**==}`, `==}{>>…<<}**`).
  let end = at;
  for (;;) {
    if (text.startsWith('==}', end)) {
      end += 3;
      while (text.startsWith('{>>', end)) {
        const close = text.indexOf('<<}', end);
        if (close === -1) return text.length;
        end = close + 3;
      }
    } else if (end < text.length && MARKS_AFTER.includes(text[end])) end++;
    else return end;
  }
}

/**
 * Whether the text around the single match at `at` still shares enough of the
 * saved context to be the same place: a few letters or digits, not just a
 * space, a newline, punctuation or a list marker. Inline comment markup
 * (`{==…==}{>>…<<}`) and formatting marks around the quote (`**`, `_`, `==`,
 * `~~`, `[[ ]]`) are skipped on both sides, so formatting the word, removing
 * markup, or another marked-up copy does not change the answer. When the saved context has fewer
 * word characters than required, all of them must match; with none, there is
 * nothing to contradict the match.
 */
function contextConfirms(doc: string, at: number, anchor: TextAnchor): boolean {
  const { shared, saved } = sharedAround(doc, at, anchor);
  return wordChars(shared) >= Math.min(MIN_SHARED_WORD_CHARS, wordChars(saved));
}

/**
 * How well the context around the copy at `at` matches: the shared run as written, or, when
 * markup was added or removed around the quote (bold, `[[ ]]`, inline comments), the run with
 * that markup skipped. The skipped comparison counts only when it shares real words, so
 * spaces and list markers never decide between copies.
 */
function contextScore(doc: string, at: number, anchor: TextAnchor): number {
  const raw = sharedBefore(doc, at, anchor.prefix) + sharedAfter(doc, at + anchor.quote.length, anchor.suffix);
  const { shared, saved } = sharedAround(doc, at, anchor);
  const words = wordChars(saved);
  return words > 0 && wordChars(shared) >= Math.min(MIN_SHARED_WORD_CHARS, words) ? Math.max(raw, shared.length) : raw;
}

/**
 * The text around the copy at `at` that matches the saved context, with markup
 * (inline comments, formatting marks) skipped on both sides, and the saved
 * context it was compared with.
 */
function sharedAround(doc: string, at: number, anchor: TextAnchor): { shared: string; saved: string } {
  const prefix = anchor.prefix.slice(0, markupStart(anchor.prefix, anchor.prefix.length));
  const suffix = anchor.suffix.slice(markupEnd(anchor.suffix, 0));
  const before = markupStart(doc, at);
  const after = markupEnd(doc, at + anchor.quote.length);
  const shared =
    doc.slice(before - sharedBefore(doc, before, prefix), before) + doc.slice(after, after + sharedAfter(doc, after, suffix));
  return { shared, saved: prefix + suffix };
}

/**
 * Finds the anchored quote in the current note text.
 *
 * A single occurrence resolves directly, except that a short text quote must
 * still have some of its saved context around it; otherwise it is reported as
 * unconfirmed rather than silently moved to an unrelated copy. Repeated quotes are ranked by how much
 * of the captured prefix/suffix still surrounds them; a tie is reported as
 * ambiguous rather than guessed. The line hint is never used to break a tie,
 * because line numbers shift with ordinary edits above the anchor.
 */
export function resolveTextAnchor(doc: string, anchor: TextAnchor): AnchorResolution {
  if (!anchor.quote) return { status: 'missing' };
  const hits = occurrences(doc, anchor.quote);
  if (hits.length === 0) return { status: 'missing' };
  if (hits.length === 1) {
    const at = hits[0];
    const short = anchor.kind === 'text' && [...anchor.quote].length < SHORT_QUOTE_CHARS;
    if (short && !contextConfirms(doc, at, anchor)) return { status: 'unconfirmed', at };
    return { status: 'found', from: at, to: at + anchor.quote.length };
  }

  // Making the word bold must not hand the thread to another copy (see contextScore).
  const scored = hits.map((at) => ({ at, score: contextScore(doc, at, anchor) }));
  const best = Math.max(...scored.map((s) => s.score));
  const winners = scored.filter((s) => s.score === best);
  if (best > 0 && winners.length === 1) {
    return { status: 'found', from: winners[0].at, to: winners[0].at + anchor.quote.length };
  }
  return { status: 'ambiguous', candidates: winners.map((w) => w.at) };
}
