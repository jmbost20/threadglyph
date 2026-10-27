import { describe, expect, it } from 'vitest';
import { captureTextAnchor } from '../src/anchor/textAnchor';
import { addReply, createThread, editMessage, setStatus } from '../src/model/thread';
import type { TextAnchor, ThreadRecord } from '../src/model/types';
import {
  anchorProblem,
  anchorState,
  buildThreadViews,
  draftKey,
  filterViews,
  formatTimestamp,
  matchesQuery,
  originLabel,
  previewQuote,
} from '../src/ui/viewModel';
import { ai, fakeClock, human } from './helpers';

const doc = 'First passage here.\nSecond passage here.\nThird.\n';

function source(threads: ThreadRecord[], anchors: TextAnchor[]) {
  return {
    forNote: (p: string) => threads.filter((t) => t.notePath === p),
    anchorFor: (id: string) => anchors.find((a) => a.threadId === id),
  };
}

describe('view model', () => {
  it('orders detached open threads first (to reattach), then open by position, then resolved', () => {
    const clock = fakeClock();
    const early = createThread('n.md', human, 'early', clock);
    const late = createThread('n.md', human, 'late', clock);
    const done = setStatus(createThread('n.md', human, 'done', clock), 'resolved', clock);
    const orphan = createThread('n.md', human, 'orphan', clock);
    const other = createThread('other.md', human, 'elsewhere', clock);
    const anchor = (t: ThreadRecord, s: string) =>
      captureTextAnchor(t.id, 'n.md', doc, doc.indexOf(s), doc.indexOf(s) + s.length);

    const views = buildThreadViews(
      source([late, done, orphan, early, other], [anchor(late, 'Second'), anchor(early, 'First'), anchor(done, 'Third')]),
      'n.md',
      doc,
    );

    expect(views.map((v) => v.thread.id)).toEqual([orphan.id, early.id, late.id, done.id]);
    expect(views[1]).toMatchObject({ quote: 'First', anchor: { kind: 'found', from: 0, to: 5 } });
    expect(views[0]).toMatchObject({ quote: null, anchor: { kind: 'no-anchor' } });
    // Numbers still follow reading order.
    expect(views.map((v) => v.number)).toEqual([4, 1, 2, 3]);
  });

  it('numbers threads in reading order, independent of status, and filters and searches them', () => {
    const clock = fakeClock();
    const first = setStatus(createThread('n.md', human, 'about the opening', clock), 'resolved', clock);
    const second = addReply(createThread('n.md', human, 'middle', clock), ai, 'A model reply', clock);
    const anchor = (t: ThreadRecord, s: string) =>
      captureTextAnchor(t.id, 'n.md', doc, doc.indexOf(s), doc.indexOf(s) + s.length);
    const views = buildThreadViews(source([second, first], [anchor(first, 'First'), anchor(second, 'Second')]), 'n.md', doc);

    expect(views.map((v) => [v.thread.id, v.number])).toEqual([
      [second.id, 2],
      [first.id, 1],
    ]);
    expect(filterViews(views, 'open', '').map((v) => v.number)).toEqual([2]);
    expect(filterViews(views, 'resolved', '').map((v) => v.number)).toEqual([1]);
    expect(filterViews(views, 'all', '  ').map((v) => v.number)).toEqual([2, 1]);
    expect(filterViews(views, 'all', 'opening').map((v) => v.number)).toEqual([1]);
    expect(matchesQuery(views[0], 'second PASSAGE')).toBe(false);
    expect(matchesQuery(views[0], 'second')).toBe(true);
    expect(matchesQuery(views[0], 'model reply')).toBe(true);
    expect(matchesQuery(views[0], ai.name)).toBe(true);
    expect(matchesQuery({ ...views[0], quote: null }, 'second')).toBe(false);
  });

  it('describes anchor problems', () => {
    const a = captureTextAnchor('thread-0001', 'n.md', 'x passage x', 2, 9);
    expect(anchorState('a passage b passage', { ...a, prefix: '', suffix: '' })).toEqual({ kind: 'ambiguous', count: 2 });
    expect(anchorState('gone', a)).toEqual({ kind: 'missing' });
    expect(anchorState('[passage]', a)).toEqual({ kind: 'unconfirmed' });
    expect(anchorProblem({ kind: 'found', from: 0, to: 1 })).toBeNull();
    expect(anchorProblem({ kind: 'ambiguous', count: 3 })).toMatch(/3 times/);
    expect(anchorProblem({ kind: 'missing' })).toMatch(/no longer/);
    expect(anchorProblem({ kind: 'unconfirmed' })).toMatch(/elsewhere in the note.*reattach/);
    expect(anchorProblem({ kind: 'no-anchor' })).toMatch(/reattach/);
  });

  it('labels AI output and AI output a human revised', () => {
    const clock = fakeClock();
    const t = addReply(createThread('n.md', human, 'q', clock), ai, 'a', clock);
    expect(originLabel(t.messages[0])).toBeNull();
    expect(originLabel(t.messages[1])).toBe('AI');
    const edited = editMessage(t, t.messages[1].id, 'b', clock);
    expect(originLabel(edited.messages[1])).toBe('AI · edited by you');
  });

  it('formats timestamps relative to today', () => {
    const now = new Date('2026-09-28T15:00:00');
    expect(formatTimestamp('not a date', now)).toBe('not a date');
    expect(formatTimestamp(new Date('2026-09-28T09:05:00').toISOString(), now)).not.toMatch(/Sep/);
    expect(formatTimestamp(new Date('2026-09-01T09:05:00').toISOString(), now)).toMatch(/Sep/);
    expect(formatTimestamp(new Date('2025-09-01T09:05:00').toISOString(), now)).toMatch(/2025/);
  });

  it('previews long quotes without breaking characters', () => {
    expect(previewQuote('  a\n\n b  ')).toBe('a b');
    const long = '😀'.repeat(10);
    expect(previewQuote(long, 5)).toBe('😀😀😀😀…');
  });

  it('builds distinct draft keys', () => {
    expect(new Set([draftKey.newThread('a'), draftKey.reply('a'), draftKey.edit('a', 'b')]).size).toBe(3);
  });
});

describe('custom comment filters', () => {
  it('combines status, search, agent, recency and inclusive local dates on the same comment', () => {
    const clock = fakeClock();
    const thread = addReply(createThread('n.md', human, 'question', clock), ai, 'answer', clock);
    thread.messages[0].createdAt = new Date(2026, 8, 29, 12).toISOString();
    thread.messages[1].createdAt = new Date(2026, 8, 20, 12).toISOString();
    const views = buildThreadViews(source([thread], []), 'n.md', doc);
    const now = new Date(2026, 8, 30, 0).getTime();
    const custom = { agent: ai.name, days: 0, from: '2026-09-20', to: '2026-09-20' };
    expect(filterViews(views, 'open', 'answer', custom, now)).toHaveLength(1);
    expect(filterViews(views, 'resolved', '', custom, now)).toHaveLength(0);
    expect(filterViews(views, 'all', 'unmatched', custom, now)).toHaveLength(0);
    expect(filterViews(views, 'all', '', { ...custom, days: 7 }, now)).toHaveLength(0);
    expect(filterViews(views, 'all', '', { ...custom, from: '2026-09-29', to: '' }, now)).toHaveLength(0);
    expect(filterViews(views, 'all', '', { ...custom, agent: '', from: '2026-09-29', to: '' }, now)).toHaveLength(1);
    expect(filterViews(views, 'all', '', { ...custom, from: '2026-09-21' }, now)).toHaveLength(0);
    expect(filterViews(views, 'all', '', { ...custom, from: 'invalid' }, now)).toHaveLength(0);
  });
});
