/**
 * The agent answers in prose plus, optionally, one fenced ```threadglyph block of
 * JSON: either edits to the text it was given, or a request to read other notes.
 * Nothing here touches a note; it only turns a reply into a checked proposal.
 */

export interface AgentEdit {
  /** Exact text copied from the target; empty means "add at the end of the target". */
  old: string;
  new: string;
}

export interface ReadRequest {
  search: string | null;
  notes: string[];
}

export interface ParsedReply {
  /** The prose, with the JSON block removed. */
  reply: string;
  edits: AgentEdit[];
  /** The complete new text of the target (a ```threadglyph-replace block), when the agent rewrote all of it. */
  replacement?: string;
  read: ReadRequest | null;
  /** The block was there but unreadable; it is dropped (it may quote the note). */
  malformed?: true;
}

const BLOCK = /```threadglyph[ \t]*\n([\s\S]*?)```/i;
const REPLACE = /```threadglyph-replace[^\n]*\n([\s\S]*?)\n?```/i;
/** Small models often label the block `json`; it counts when it carries our keys. */
const JSON_BLOCK = /```json[ \t]*\n(\s*\{[\s\S]*?"(?:edits|read)"[\s\S]*?)```/i;

const isEdit = (e: unknown): e is AgentEdit =>
  !!e && typeof (e as AgentEdit).old === 'string' && typeof (e as AgentEdit).new === 'string';

/**
 * Tolerant: a reply without a block is just a reply. The block is always
 * removed from the prose, even when its JSON cannot be read.
 */
export function parseAgentReply(text: string): ParsedReply {
  const replace = REPLACE.exec(text);
  if (replace) return { reply: text.replace(replace[0], '').trim(), edits: [], read: null, replacement: replace[1] };
  const match = BLOCK.exec(text) ?? JSON_BLOCK.exec(text);
  const prose = (match ? text.replace(match[0], '') : text).trim();
  if (!match) return { reply: prose, edits: [], read: null };
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return { reply: prose, edits: [], read: null, malformed: true };
  }
  const raw = data as { edits?: unknown; read?: { search?: unknown; notes?: unknown } };
  const edits = Array.isArray(raw.edits) ? raw.edits.filter(isEdit).map((e) => ({ old: e.old, new: e.new })) : [];
  let read: ReadRequest | null = null;
  if (raw.read && typeof raw.read === 'object') {
    const search = typeof raw.read.search === 'string' && raw.read.search.trim() ? raw.read.search.trim() : null;
    const notes = Array.isArray(raw.read.notes)
      ? raw.read.notes.filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.trim())
      : [];
    if (search || notes.length) read = { search, notes };
  }
  return { reply: prose, edits, read };
}

/** Whether the reply proposes any change (edits, or a whole replacement). */
export const proposesChange = (parsed: ParsedReply) => parsed.edits.length > 0 || parsed.replacement !== undefined;

/** The agent's change applied to `base`: its whole replacement, or its edits. */
export function applyReply(base: string, parsed: ParsedReply): Applied {
  if (parsed.replacement === undefined) return applyEdits(base, parsed.edits);
  // Trailing blank lines are formatting noise from the fence, not part of the note.
  const text = parsed.replacement.replace(/\s+$/, '');
  if (!text.trim()) return { ok: false, message: 'The agent sent an empty replacement. Nothing was changed.' };
  if (text === base.replace(/\s+$/, '')) return { ok: false, message: 'The agent found nothing to change.', noop: true };
  return { ok: true, text: base.endsWith('\n') ? `${text}\n` : text };
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s).replace(/\n/g, '⏎');

/** `noop` marks edits that leave the text as it was: the agent found nothing to change. */
export type Applied = { ok: true; text: string } | { ok: false; message: string; noop?: true };

/**
 * Applies edits to `base`. Every `old` must appear exactly once and edits must
 * not overlap; otherwise nothing is applied and the reason is returned.
 */
export function applyEdits(base: string, edits: AgentEdit[]): Applied {
  if (!edits.length) return { ok: false, message: 'The agent did not propose any change.' };
  const spans: { from: number; to: number; text: string }[] = [];
  for (const edit of edits) {
    if (edit.old === '') {
      const sep = base === '' || base.endsWith('\n') || edit.new.startsWith('\n') ? '' : '\n';
      spans.push({ from: base.length, to: base.length, text: sep + edit.new });
      continue;
    }
    const at = occurrences(base, edit.old);
    if (at.length === 0) return { ok: false, message: `The agent's edit does not match the note: “${clip(edit.old)}” is not there.` };
    if (at.length > 1) return { ok: false, message: `The agent's edit is ambiguous: “${clip(edit.old)}” appears ${at.length} times.` };
    spans.push({ from: at[0], to: at[0] + edit.old.length, text: edit.new });
  }
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from < spans[i - 1].to) return { ok: false, message: 'The agent proposed overlapping edits.' };
  }
  let text = base;
  for (const span of [...spans].reverse()) text = text.slice(0, span.from) + span.text + text.slice(span.to);
  if (text === base) return { ok: false, message: 'The agent found nothing to change.', noop: true };
  return { ok: true, text };
}
