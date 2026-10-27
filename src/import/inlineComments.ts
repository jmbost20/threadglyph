import { SCHEMA_VERSION, type Author, type Message, type ThreadRecord } from '../model/types';
import type { Clock } from '../model/thread';

/**
 * Reads comments stored inside the note as inline markup:
 * `{==passage==}{>>author|date|type: text<<}{>>…<<}`.
 *
 * This is read-only: the note is never changed, and its markup stays where it
 * is. Importing creates Threadglyph threads anchored to the passage inside the
 * markup, so a plugin that shows the markup and Threadglyph can show the same
 * conversation side by side.
 * Opinion tags (agree, disagree, question…) are not carried over, by design.
 */

export interface LegacyEntry {
  author: string;
  /** As written, e.g. `2026-09-16 14:20`; empty when missing. */
  date: string;
  type: string;
  text: string;
}

export interface LegacyThread {
  quote: string;
  /** Offsets of the passage (inside `{==…==}`) in the note. */
  from: number;
  to: number;
  entries: LegacyEntry[];
  resolved: boolean;
}


/** The markup escapes `<<` and `>>` inside bodies. */
const unescape = (text: string) => text.replaceAll('‹‹', '<<').replaceAll('››', '>>');

/**
 * `author|date|type: text`, or the older `author|date: text`. Parsed by hand,
 * not by regex, so a long or malformed entry cannot cause slow backtracking.
 */
export function parseEntry(raw: string): LegacyEntry {
  const [author = '', date, ...rest] = raw.split('|');
  if (date !== undefined && author.trim()) {
    const tail = rest.join('|');
    const colon = tail.indexOf(':');
    if (rest.length && date.trim() && colon > 0) {
      return { author: author.trim(), date: date.trim(), type: tail.slice(0, colon).trim(), text: unescape(tail.slice(colon + 1).trim()) };
    }
    const short = date.indexOf(':');
    if (!rest.length && short > 0) {
      return { author: author.trim(), date: date.slice(0, short).trim(), type: 'note', text: unescape(date.slice(short + 1).trim()) };
    }
  }
  return { author: 'unknown', date: '', type: 'note', text: unescape(raw.trim()) };
}

const runLength = (text: string, at: number) => {
  let end = at;
  while (text[end] === '`') end++;
  return end - at;
};

/** Fenced code blocks: from a ``` or ~~~ line to a bare closing fence of the same kind, at least as long, or the end. */
function fencedBlocks(doc: string): [number, number][] {
  const blocks: [number, number][] = [];
  let open: { marker: string; from: number } | null = null;
  let at = 0;
  for (const line of doc.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const marker = m?.[1];
    // A closing fence carries nothing after its marker: a ```js line inside a block is content.
    const bare = m !== null && line.slice(m[0].length).trim() === '';
    if (!open && marker) open = { marker, from: at };
    else if (open && marker && bare && marker.startsWith(open.marker[0]) && marker.length >= open.marker.length) {
      blocks.push([open.from, at + line.length]);
      open = null;
    }
    at += line.length + 1;
  }
  if (open) blocks.push([open.from, doc.length]);
  return blocks;
}

/**
 * Offsets of code in `doc`: fenced blocks, and inline code spans, which close
 * at the next backtick run of the same length (so ``a `b` c`` is one span)
 * within the paragraph. Scanned by hand: no regex backtracking.
 */
export function codeRanges(doc: string): [number, number][] {
  const blocks = fencedBlocks(doc);
  const ranges = [...blocks];
  let i = doc.indexOf('`');
  while (i !== -1) {
    const block = blocks.find(([from, to]) => from <= i && i < to);
    if (block) {
      i = doc.indexOf('`', block[1]);
      continue;
    }
    const n = runLength(doc, i);
    const paragraphEnd = doc.indexOf('\n\n', i);
    const nextBlock = blocks.find(([from]) => from > i)?.[0] ?? doc.length;
    const limit = Math.min(paragraphEnd === -1 ? doc.length : paragraphEnd, nextBlock);
    let close = doc.indexOf('`', i + n);
    while (close !== -1 && close < limit && runLength(doc, close) !== n) close = doc.indexOf('`', close + runLength(doc, close));
    if (close !== -1 && close < limit) {
      ranges.push([i, close + n]);
      i = doc.indexOf('`', close + n);
    } else {
      i = doc.indexOf('`', i + n);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Scanned by hand: a passage ends at its own `==}`, so a plain highlight with
 * no comment is never merged into the next commented one.
 */
export function parseLegacyComments(doc: string): LegacyThread[] {
  const found: LegacyThread[] = [];
  const code = codeRanges(doc);
  let open = doc.indexOf('{==');
  while (open !== -1) {
    // Markup shown as an example inside code is not a comment.
    if (code.some(([from, to]) => from <= open && open < to)) {
      open = doc.indexOf('{==', open + 3);
      continue;
    }
    const close = doc.indexOf('==}', open + 3);
    if (close === -1) break;
    const entries: LegacyEntry[] = [];
    let cursor = close + 3;
    while (doc.startsWith('{>>', cursor)) {
      const end = doc.indexOf('<<}', cursor + 3);
      if (end === -1) break;
      entries.push(parseEntry(doc.slice(cursor + 3, end)));
      cursor = end + 3;
    }
    if (entries.length && close > open + 3) {
      const from = open + 3;
      // The old plugin marks a resolved thread with a trailing `resolve` entry.
      found.push({ quote: doc.slice(from, close), from, to: close, entries, resolved: entries.at(-1)?.type === 'resolve' });
    }
    open = doc.indexOf('{==', cursor);
  }
  return found;
}

/** One message to import, or null for entries that are state rather than conversation. */
export function entryMessage(entry: LegacyEntry): { body: string } | null {
  if (entry.type === 'react' || entry.type === 'resolve' || !entry.text.trim()) return null;
  if (entry.type === 'suggest') return { body: `Suggested wording: ${entry.text}` };
  if (entry.type === 'accepted') return { body: `Suggested wording (accepted): ${entry.text}` };
  if (entry.type === 'declined') return { body: `Suggested wording (declined): ${entry.text}` };
  return { body: entry.text };
}

/** `2026-09-16 14:20`, `2026-09-16T14:20:00Z` or `2026-09-16` as ISO; null when unreadable. */
export function legacyDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(date.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export interface ImportPeople {
  /** Names the old plugin used for assistants, e.g. Claude, Codex, Gemini, Local. */
  assistants: string[];
  /** The old plugin's default human name (`user`) becomes this. */
  you: string;
}

export function legacyAuthor(name: string, people: ImportPeople): Author {
  if (people.assistants.some((a) => a.toLowerCase() === name.toLowerCase())) return { kind: 'ai', name };
  return { kind: 'human', name: name === 'user' || name === 'unknown' ? people.you : name };
}

/** A Threadglyph thread holding the legacy conversation, or null when it has no messages to keep. */
export function importedThread(
  notePath: string,
  legacy: LegacyThread,
  people: ImportPeople,
  clock: Clock,
): ThreadRecord | null {
  const importedAt = clock.now();
  // Every entry's date counts as a neighbour, including reactions and resolves that are not imported.
  const all = legacy.entries.map((entry) => ({ entry, message: entryMessage(entry), date: legacyDate(entry.date) }));
  // An entry with a missing or unreadable date takes its neighbour's time (the one before it,
  // or else the next dated one), never the import time, which would push every later message
  // to today. Only a conversation with no readable dates at all is dated at the import.
  const fallback = (i: number) =>
    all.slice(0, i).reverse().find((k) => k.date)?.date ?? all.slice(i + 1).find((k) => k.date)?.date ?? importedAt;
  const messages: Message[] = [];
  let last = '';
  for (const [i, { entry, message, date }] of all.entries()) {
    if (!message) continue;
    const author = legacyAuthor(entry.author, people);
    // Keep order even when dates are out of order (ISO strings compare chronologically).
    const dated = date ?? fallback(i);
    const createdAt = dated > last ? dated : last;
    last = createdAt;
    messages.push({
      id: clock.newId(),
      author,
      origin: author.kind === 'ai' ? 'ai' : 'human',
      createdAt,
      body: message.body,
      revisions: [],
    });
  }
  if (!messages.length) return null;
  return {
    schema: SCHEMA_VERSION,
    id: clock.newId(),
    notePath,
    anchorKind: 'text',
    status: legacy.resolved ? 'resolved' : 'open',
    createdAt: messages[0].createdAt,
    updatedAt: importedAt,
    revision: 1,
    messages,
  };
}

export type ImportItem =
  | { status: 'new'; legacy: LegacyThread; messages: number }
  | { status: 'already-imported' | 'nothing-to-import'; legacy: LegacyThread; messages: number };

/**
 * What an import of `doc` would do. A legacy thread counts as already imported
 * when an existing thread has the same passage and the same first message.
 */
export function planImport(doc: string, existing: { quote: string | null; firstBody: string | null }[]): ImportItem[] {
  return parseLegacyComments(doc).map((legacy) => {
    const bodies = legacy.entries.map(entryMessage).filter((m): m is { body: string } => m !== null);
    if (!bodies.length) return { status: 'nothing-to-import', legacy, messages: 0 };
    const duplicate = existing.some((e) => e.quote === legacy.quote && e.firstBody === bodies[0].body);
    return { status: duplicate ? 'already-imported' : 'new', legacy, messages: bodies.length };
  });
}
