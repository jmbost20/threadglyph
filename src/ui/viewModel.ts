import { findImageEmbeds } from '../anchor/imageEmbed';
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
  /** Vault path of the image, for image threads. */
  imagePath: string | null;
  anchor: AnchorState;
  /** 1-based label shared by the panel card and the badge in the note, in reading order. */
  number: number;
}

export type ThreadFilter = 'open' | 'resolved' | 'all';

export interface ThreadSource {
  forNote(notePath: string): ThreadRecord[];
  anchorFor(id: string): TextAnchor | undefined;
}

/** Maps a link as written in `fromNote` to a vault path (Obsidian's link resolution), or null. */
export type LinkResolver = (link: string, fromNote: string) => string | null;

export function anchorState(doc: string, anchor: TextAnchor | undefined, resolveLink?: LinkResolver): AnchorState {
  if (!anchor) return { kind: 'no-anchor' };
  const r = resolveTextAnchor(doc, anchor);
  if (r.status === 'found') return { kind: 'found', from: r.from, to: r.to };
  if (r.status === 'missing' && anchor.kind === 'image' && resolveLink) {
    // The embed text changed (a rename rewrote the link, or a size was added): find the same file instead.
    const hits = findImageEmbeds(doc).filter((e) => resolveLink(e.link, anchor.notePath) === anchor.imagePath);
    if (hits.length === 1) return { kind: 'found', from: hits[0].from, to: hits[0].to };
    if (hits.length > 1) return { kind: 'ambiguous', count: hits.length };
  }
  if (r.status === 'ambiguous') return { kind: 'ambiguous', count: r.candidates.length };
  return { kind: 'missing' };
}

/**
 * Open threads first (in document order when anchored), then resolved ones.
 * Numbers follow reading order across all threads, so resolving a thread never
 * renumbers the others.
 */
export function buildThreadViews(
  source: ThreadSource,
  notePath: string,
  doc: string,
  resolveLink?: LinkResolver,
): ThreadView[] {
  const views: ThreadView[] = source.forNote(notePath).map((thread) => {
    const anchor = source.anchorFor(thread.id);
    return {
      thread,
      quote: anchor?.quote ?? null,
      imagePath: anchor?.imagePath ?? null,
      anchor: anchorState(doc, anchor, resolveLink),
      number: 0,
    };
  });
  const position = (v: ThreadView) => (v.anchor.kind === 'found' ? v.anchor.from : Number.MAX_SAFE_INTEGER);
  const byPosition = (a: ThreadView, b: ThreadView) =>
    position(a) - position(b) || a.thread.createdAt.localeCompare(b.thread.createdAt);
  [...views].sort(byPosition).forEach((v, i) => (v.number = i + 1));
  return views.sort(
    (a, b) => Number(a.thread.status === 'resolved') - Number(b.thread.status === 'resolved') || byPosition(a, b),
  );
}

/** Case-insensitive match against the quote, message bodies and author names. */
export function matchesQuery(view: ThreadView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [view.quote ?? '', ...view.thread.messages.flatMap((m) => [m.body, m.author.name])];
  return haystack.some((text) => text.toLocaleLowerCase().includes(needle));
}

export function filterViews(views: ThreadView[], filter: ThreadFilter, query: string): ThreadView[] {
  return views.filter((v) => (filter === 'all' || v.thread.status === filter) && matchesQuery(v, query));
}

export function anchorProblem(state: AnchorState, image = false): string | null {
  if (image && state.kind === 'ambiguous') {
    return `This image is embedded ${state.count} times. Put the cursor on the right one and reattach.`;
  }
  if (image && state.kind === 'missing') {
    return 'This image is no longer embedded in the note. Put the cursor on an image and reattach, or keep the thread as is.';
  }
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
