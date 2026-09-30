import type { Editor } from 'obsidian';
import { lineDiff, type DiffLine } from './diff';
import { applyReply, type ParsedReply } from './proposal';
import type { Region } from './target';

/**
 * A change the agent proposed. Held in memory only (it contains note text) and
 * applied to the note only when the user presses Accept.
 */
export interface Proposal {
  notePath: string;
  /** The text replaced on Accept, as it was when the proposal was made. */
  region: Region;
  /** What `region.text` becomes. */
  result: string;
  reply: string;
  diff: DiffLine[];
}

export type Built = { ok: true; proposal: Proposal } | { ok: false; message: string; noop?: true };

/**
 * Checks the agent's edits against the text it was shown (`base`, which is
 * `region.text` unless the request line itself is removed on Accept).
 */
export function buildProposal(notePath: string, region: Region, parsed: ParsedReply, base = region.text): Built {
  const applied = applyReply(base, parsed);
  if (!applied.ok) return applied;
  return {
    ok: true,
    proposal: { notePath, region, result: applied.text, reply: parsed.reply, diff: lineDiff(region.text, applied.text) },
  };
}

/**
 * Where the proposal's text is in `doc` now. The text and what surrounds it
 * must still be there, unchanged, at its old place or exactly one other place
 * (lines above it changed). An identical copy elsewhere is never taken for it;
 * any doubt returns null.
 */
export function locateRegion(doc: string, region: Region): number | null {
  const before = region.before ?? '';
  const needle = before + region.text + (region.after ?? '');
  const start = region.from - before.length;
  if (start >= 0 && start + needle.length <= doc.length && doc.startsWith(needle, start)) return region.from;
  const at = doc.indexOf(needle);
  if (at === -1 || needle === '' || doc.indexOf(needle, at + 1) !== -1) return null;
  return at + before.length;
}

export const STALE_MESSAGE = 'The note changed since this preview. Nothing was changed; ask the agent again.';

/**
 * Applies an accepted proposal as one editor transaction, so a single undo
 * restores the note. Refuses when the text changed since the preview.
 */
export function applyProposal(editor: Editor, proposal: Proposal): { ok: true } | { ok: false; message: string } {
  const at = locateRegion(editor.getValue(), proposal.region);
  if (at === null) return { ok: false, message: STALE_MESSAGE };
  editor.transaction({
    changes: [
      {
        from: editor.offsetToPos(at),
        to: editor.offsetToPos(at + proposal.region.text.length),
        text: proposal.result,
      },
    ],
  });
  return { ok: true };
}
