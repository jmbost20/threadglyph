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

export interface FencedBlock {
  /** The language label, lower-cased ("" when there is none). */
  lang: string;
  body: string;
  /** The block as it appears in the reply, fences included. */
  raw: string;
  /** False when the reply ended before the closing fence (a cut-off answer). */
  closed: boolean;
}

const FENCE = /^ {0,3}(`{3,})([\w-]*)/;

/**
 * The fenced blocks of a reply, in order. A block ends at a bare fence at least
 * as long as its opening one; fenced blocks inside it (a rewritten note may hold
 * code) are skipped, so they do not end it early.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split('\n');
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    let inner = 0;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const fence = FENCE.exec(lines[j]);
      if (!fence) continue;
      if (fence[2]) inner++;
      else if (inner > 0) inner--;
      else if (fence[1].length >= open[1].length && lines[j].trim() === fence[1]) {
        end = j;
        break;
      }
    }
    blocks.push({
      lang: open[2].toLowerCase(),
      body: lines.slice(i + 1, end).join('\n'),
      raw: lines.slice(i, end + 1).join('\n'),
      closed: end < lines.length,
    });
    i = end;
  }
  return blocks;
}

/** Small models often label the block `json`; it counts when it carries our keys. */
const OUR_KEYS = /^\s*\{[\s\S]*"(?:edits|read)"/;

const CONTROL: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' };

/**
 * Small models copy tabs and line breaks into JSON strings as they are, which
 * strict JSON forbids; this escapes them inside strings only.
 */
export function escapeRawControls(json: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString && ch === '\\') {
      out += ch + (json[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') inString = !inString;
    out += inString ? (CONTROL[ch] ?? ch) : ch;
  }
  return out;
}

/** JSON.parse, retried after escaping the raw tabs and line breaks small models leave in strings. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(escapeRawControls(text));
  }
}

const isEdit = (e: unknown): e is AgentEdit =>
  !!e && typeof (e as AgentEdit).old === 'string' && typeof (e as AgentEdit).new === 'string';

/**
 * Tolerant: a reply without a block is just a reply. The block is always
 * removed from the prose, even when its JSON cannot be read.
 */
export function parseAgentReply(text: string): ParsedReply {
  const blocks = fencedBlocks(text);
  const without = (block: FencedBlock) => text.replace(block.raw, '').trim();
  // A rewrite cut off before its closing fence would delete the rest of the target.
  const rewrite = (block: FencedBlock, body: string): ParsedReply =>
    block.closed ? { reply: without(block), edits: [], read: null, replacement: body } : { reply: without(block), edits: [], read: null, malformed: true };
  const replace = blocks.find((b) => b.lang === 'threadglyph-replace');
  if (replace) return rewrite(replace, replace.body);
  const match = blocks.find((b) => b.lang === 'threadglyph') ?? blocks.find((b) => b.lang === 'json' && OUR_KEYS.test(b.body));
  if (!match) {
    // ...and the rewritten text `markdown`; in an agent reply, that block is the new text.
    const markdown = blocks.find((b) => b.lang === 'markdown' || b.lang === 'md');
    return markdown ? rewrite(markdown, markdown.body) : { reply: text.trim(), edits: [], read: null };
  }
  const prose = without(match);
  // Small models sometimes put the rewritten Markdown itself in the threadglyph block.
  if (!match.body.trim().startsWith('{')) return rewrite(match, match.body);
  let data: unknown;
  try {
    data = parseJson(match.body);
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

/**
 * `noop` marks edits that leave the text as it was: the agent found nothing to change.
 * `loose` marks a long quote that was found by its first and last lines, not word for word.
 */
export type Applied = { ok: true; text: string; loose?: true } | { ok: false; message: string; noop?: true };

/** Quotes shorter than this many lines must match exactly. */
const LOOSE_MIN_LINES = 3;

/**
 * Small models cannot copy a long passage exactly. A quote of several lines whose
 * first and last lines each appear once in `base` (in that order) stands for the
 * lines between them, as long as that span is about as long as the quote.
 */
function locateLoosely(base: string, old: string): { from: number; to: number } | null {
  const lines = old.split('\n').filter((l) => l.trim());
  if (lines.length < LOOSE_MIN_LINES) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const starts = occurrences(base, first);
  const ends = occurrences(base, last);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return null;
  const from = starts[0];
  const to = ends[0] + last.length;
  const ratio = (to - from) / old.trim().length;
  return ratio > 0.5 && ratio < 2 ? { from, to } : null;
}

/**
 * Applies edits to `base`. Every `old` must appear exactly once and edits must
 * not overlap; otherwise nothing is applied and the reason is returned.
 */
export function applyEdits(base: string, edits: AgentEdit[]): Applied {
  if (!edits.length) return { ok: false, message: 'The agent did not propose any change.' };
  const spans: { from: number; to: number; text: string }[] = [];
  let loose = false;
  for (const edit of edits) {
    if (edit.old === '') {
      const sep = base === '' || base.endsWith('\n') || edit.new.startsWith('\n') ? '' : '\n';
      spans.push({ from: base.length, to: base.length, text: sep + edit.new });
      continue;
    }
    const at = occurrences(base, edit.old);
    const near = at.length === 0 ? locateLoosely(base, edit.old) : null;
    if (near) {
      loose = true;
      spans.push({ ...near, text: edit.new });
      continue;
    }
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
  return loose ? { ok: true, text, loose: true } : { ok: true, text };
}
