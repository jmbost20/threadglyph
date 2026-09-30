import type { AiAdapter, AiRequest, AiResult } from '../ai/types';
import { parseAgentReply, type ReadRequest } from './proposal';

/** How much of one other note is sent, in characters. */
export const MAX_NOTE_CHARS = 8_000;
/** How many notes a search may add. */
export const MAX_SEARCH_HITS = 3;
/** How many times one request may ask to read more notes. */
export const MAX_READ_ROUNDS = 2;

export interface VaultNote {
  path: string;
  text: string;
}

/** Daily or journal notes: never picked up by a search, and flagged when named. */
export function isDailyNote(path: string): boolean {
  return /(^|\/)\d{4}-\d{2}-\d{2}[^/]*\.md$/i.test(path) || /(^|\/)(daily|journal)[^/]*\//i.test(path);
}

export function capNote(path: string, text: string): VaultNote {
  if (text.length <= MAX_NOTE_CHARS) return { path, text };
  return { path, text: `${text.slice(0, MAX_NOTE_CHARS)}\n[…truncated]` };
}

/** The best matches for a search, by how often its words appear. Daily notes are left out. */
export function rankNotes(query: string, candidates: VaultNote[], limit = MAX_SEARCH_HITS): VaultNote[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  return candidates
    .filter((c) => !isDailyNote(c.path))
    .map((c) => {
      const hay = `${c.path}\n${c.text}`.toLowerCase();
      return { c, score: words.reduce((sum, w) => sum + hay.split(w).length - 1, 0) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.c.path.localeCompare(b.c.path))
    .slice(0, limit)
    .map((s) => capNote(s.c.path, s.c.text));
}

export interface AgentIo {
  /** Asks the user; nothing is read unless this resolves true. */
  askPermission(read: ReadRequest): Promise<boolean>;
  readNotes(read: ReadRequest): Promise<VaultNote[]>;
}

/**
 * Asks the agent, letting it read other notes when the user allows: a reply
 * that only asks to read is answered by asking again with those notes.
 */
export async function runAgent(adapter: AiAdapter, request: AiRequest, signal: AbortSignal, io: AgentIo): Promise<AiResult> {
  let current = request;
  for (let round = 0; ; round++) {
    const result = await adapter.ask(current, signal);
    if (!result.ok) return result;
    const parsed = parseAgentReply(result.text);
    if (!parsed.read || parsed.edits.length) return result;
    if (round >= MAX_READ_ROUNDS) return { ok: true, text: `${parsed.reply}\n\n(It asked to read more notes again; stopped here.)`.trim() };
    const allowed = await io.askPermission(parsed.read);
    if (signal.aborted) return { ok: false, kind: 'cancelled', message: 'Cancelled.' };
    if (!allowed) return { ok: true, text: `${parsed.reply}\n\n(You did not let it read other notes.)`.trim() };
    const notes = await io.readNotes(parsed.read);
    const known = new Set((current.vaultNotes ?? []).map((n) => n.path));
    const added = notes.filter((n) => !known.has(n.path));
    if (!added.length) return { ok: true, text: `${parsed.reply}\n\n(No matching notes were found.)`.trim() };
    current = { ...current, vaultNotes: [...(current.vaultNotes ?? []), ...added] };
  }
}
