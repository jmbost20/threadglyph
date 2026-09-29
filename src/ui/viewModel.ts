import { resolveTextAnchor } from '../anchor/textAnchor';
import type { Message, TextAnchor, ThreadRecord } from '../model/types';

export type AnchorState =
  | { kind: 'found'; from: number; to: number }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'missing' }
  /** The local anchor file is absent, e.g. on a fresh clone of the vault. */
  | { kind: 'no-anchor' };

export interface ThreadView {
  thread: ThreadRecord;
  quote: string | null;
  anchor: AnchorState;
}

export interface ThreadSource {
  forNote(notePath: string): ThreadRecord[];
  anchorFor(id: string): TextAnchor | undefined;
}

export function anchorState(doc: string, anchor: TextAnchor | undefined): AnchorState {
  if (!anchor) return { kind: 'no-anchor' };
  const r = resolveTextAnchor(doc, anchor);
  if (r.status === 'found') return { kind: 'found', from: r.from, to: r.to };
  if (r.status === 'ambiguous') return { kind: 'ambiguous', count: r.candidates.length };
  return { kind: 'missing' };
}

/** Open threads first (in document order when anchored), then resolved ones. */
export function buildThreadViews(source: ThreadSource, notePath: string, doc: string): ThreadView[] {
  const views = source.forNote(notePath).map((thread) => {
    const anchor = source.anchorFor(thread.id);
    return { thread, quote: anchor?.quote ?? null, anchor: anchorState(doc, anchor) };
  });
  const position = (v: ThreadView) => (v.anchor.kind === 'found' ? v.anchor.from : Number.MAX_SAFE_INTEGER);
  return views.sort(
    (a, b) =>
      Number(a.thread.status === 'resolved') - Number(b.thread.status === 'resolved') ||
      position(a) - position(b) ||
      a.thread.createdAt.localeCompare(b.thread.createdAt),
  );
}

export function anchorProblem(state: AnchorState): string | null {
  switch (state.kind) {
    case 'found':
      return null;
    case 'ambiguous':
      return `The quoted text now appears ${state.count} times. Select the right passage and reattach.`;
    case 'missing':
      return 'The quoted text is no longer in this note. Select new text and reattach, or keep the thread as is.';
    case 'no-anchor':
      return 'This device has no saved anchor for the thread. Select the passage and reattach.';
  }
}

export function originLabel(message: Message): string | null {
  if (message.origin === 'ai') return 'AI';
  if (message.origin === 'ai-edited') return 'AI · edited by you';
  return null;
}

export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/** Truncates a long quote for the panel header without splitting surrogate pairs. */
export function previewQuote(quote: string, max = 280): string {
  const chars = [...quote.replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** Keys for unsaved text so drafts survive re-rendering and panel navigation. */
export const draftKey = {
  newThread: (notePath: string) => `new:${notePath}`,
  reply: (threadId: string) => `reply:${threadId}`,
  edit: (threadId: string, messageId: string) => `edit:${threadId}:${messageId}`,
};
