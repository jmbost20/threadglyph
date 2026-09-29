import { SCHEMA_VERSION, type Author, type Message, type ThreadRecord } from '../model/types';
import type { Clock } from '../model/thread';

/**
 * Reads comments written by the old Agent Comments plugin, which stores them
 * inside the note as `{==passage==}{>>author|date|type: text<<}{>>…<<}`.
 *
 * This is read-only: the note is never changed, and its markup stays where it
 * is. Importing creates Threadglyph threads anchored to the passage inside the
 * markup, so both plugins can show the same conversation side by side.
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

const FULL = /\{==([\s\S]+?)==\}((?:\{>>[\s\S]+?<<\})+)/g;
const BLOCK = /\{>>([\s\S]+?)<<\}/g;

/** The old plugin escaped `<<` and `>>` inside bodies. */
const unescape = (text: string) => text.replace(/‹‹/g, '<<').replace(/››/g, '>>');

export function parseEntry(raw: string): LegacyEntry {
  const full = /^([^|]+)\|([^|]+)\|([^:]+):\s*([\s\S]*)$/.exec(raw);
  if (full) return { author: full[1].trim(), date: full[2].trim(), type: full[3].trim(), text: unescape(full[4].trim()) };
  const short = /^([^|]+)\|([^:]+):\s*([\s\S]*)$/.exec(raw);
  if (short) return { author: short[1].trim(), date: short[2].trim(), type: 'note', text: unescape(short[3].trim()) };
  return { author: 'unknown', date: '', type: 'note', text: unescape(raw.trim()) };
}

export function parseLegacyComments(doc: string): LegacyThread[] {
  const found: LegacyThread[] = [];
  for (const m of doc.matchAll(FULL)) {
    const entries = [...m[2].matchAll(BLOCK)].map((b) => parseEntry(b[1]));
    const from = m.index + 3;
    found.push({
      quote: m[1],
      from,
      to: from + m[1].length,
      entries,
      // The old plugin marks a resolved thread with a trailing `resolve` entry.
      resolved: entries[entries.length - 1]?.type === 'resolve',
    });
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
  const messages: Message[] = [];
  let last = '';
  for (const entry of legacy.entries) {
    const message = entryMessage(entry);
    if (!message) continue;
    const author = legacyAuthor(entry.author, people);
    // Keep order even when dates are missing or out of order.
    const createdAt = [legacyDate(entry.date) ?? importedAt, last].sort().pop()!;
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
