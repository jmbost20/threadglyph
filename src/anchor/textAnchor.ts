import { SCHEMA_VERSION, type TextAnchor } from '../model/types';

/** Characters of surrounding context captured on each side of a quote. */
export const CONTEXT_CHARS = 64;

export type AnchorResolution =
  | { status: 'found'; from: number; to: number }
  | { status: 'ambiguous'; candidates: number[] }
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

/**
 * Finds the anchored quote in the current note text.
 *
 * A single occurrence resolves directly. Repeated quotes are ranked by how much
 * of the captured prefix/suffix still surrounds them; a tie is reported as
 * ambiguous rather than guessed. The line hint is never used to break a tie,
 * because line numbers shift with ordinary edits above the anchor.
 */
export function resolveTextAnchor(doc: string, anchor: TextAnchor): AnchorResolution {
  if (!anchor.quote) return { status: 'missing' };
  const hits = occurrences(doc, anchor.quote);
  if (hits.length === 0) return { status: 'missing' };
  if (hits.length === 1) return { status: 'found', from: hits[0], to: hits[0] + anchor.quote.length };

  const scored = hits.map((at) => ({
    at,
    score: sharedBefore(doc, at, anchor.prefix) + sharedAfter(doc, at + anchor.quote.length, anchor.suffix),
  }));
  const best = Math.max(...scored.map((s) => s.score));
  const winners = scored.filter((s) => s.score === best);
  if (best > 0 && winners.length === 1) {
    return { status: 'found', from: winners[0].at, to: winners[0].at + anchor.quote.length };
  }
  return { status: 'ambiguous', candidates: winners.map((w) => w.at) };
}
