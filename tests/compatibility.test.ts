import { describe, expect, it } from 'vitest';
import { findImageEmbeds } from '../src/anchor/imageEmbed';
import { captureTextAnchor, resolveTextAnchor } from '../src/anchor/textAnchor';
import { parseLegacyComments } from '../src/import/agentComments';
import { createThread } from '../src/model/thread';
import type { TextAnchor, ThreadRecord } from '../src/model/types';
import { readingMarks } from '../src/ui/readingMarks';
import { buildThreadViews } from '../src/ui/viewModel';
import { fakeClock, human } from './helpers';

/**
 * Stage 6 compatibility checks with synthetic notes. Time limits are generous
 * ceilings for slow CI machines; docs/compatibility.md records measured times.
 */

const LINES = 20_000;
/** About 1.1 MB of Markdown: paragraphs, headings and an image every 500 lines. */
function longNote(): string {
  const lines: string[] = [];
  for (let i = 0; i < LINES; i++) {
    if (i % 500 === 0) lines.push(`## Section ${i / 500}`, `![[figure-${i / 500}.png|Figure ${i / 500}]]`);
    lines.push(`Line ${i}: the quick brown fox considers item ${i} with some ordinary words around it.`);
  }
  return lines.join('\n');
}

function threadsOn(doc: string, count: number) {
  const clock = fakeClock();
  const threads: ThreadRecord[] = [];
  const anchors: TextAnchor[] = [];
  for (let n = 0; n < count; n++) {
    const quote = `considers item ${Math.floor((n * LINES) / count)} with`;
    const from = doc.indexOf(quote);
    const thread = createThread('Long.md', human, `Comment ${n}`, clock);
    threads.push(thread);
    anchors.push(captureTextAnchor(thread.id, 'Long.md', doc, from, from + quote.length));
  }
  return {
    source: { forNote: () => threads, anchorFor: (id: string) => anchors.find((a) => a.threadId === id) },
    anchors,
  };
}

const time = (work: () => unknown) => {
  const start = performance.now();
  work();
  return performance.now() - start;
};

describe('long notes', () => {
  const doc = longNote();

  it('resolves 200 anchors in a ~1 MB note quickly enough for a refresh', () => {
    expect(doc.length).toBeGreaterThan(1_000_000);
    const { source } = threadsOn(doc, 200);
    let views: ReturnType<typeof buildThreadViews> = [];
    const ms = time(() => (views = buildThreadViews(source, 'Long.md', doc)));
    expect(views.every((v) => v.anchor.kind === 'found')).toBe(true);
    expect(views.map((v) => v.number)).toEqual(views.map((_, i) => i + 1));
    expect(ms).toBeLessThan(3000);
  });

  it('finds image embeds and builds Reading view marks in a long note', () => {
    let embeds: ReturnType<typeof findImageEmbeds> = [];
    expect(time(() => (embeds = findImageEmbeds(doc)))).toBeLessThan(500);
    expect(embeds).toHaveLength(LINES / 500);
    const { source } = threadsOn(doc, 50);
    const views = buildThreadViews(source, 'Long.md', doc);
    expect(time(() => readingMarks(views, doc))).toBeLessThan(500);
  });

  it('keeps every anchor after an edit near the top shifts the whole note', () => {
    const { anchors } = threadsOn(doc, 50);
    const edited = `Inserted paragraph from another device.\n\n${doc}`;
    for (const anchor of anchors) {
      const before = resolveTextAnchor(doc, anchor);
      const after = resolveTextAnchor(edited, anchor);
      expect(after).toMatchObject({ status: 'found' });
      if (before.status === 'found' && after.status === 'found') expect(after.from - before.from).toBe(41);
    }
  });
});

describe('coexistence with Agent Comments markup', () => {
  const note = 'Keep {==this passage==}{>>user|2026-09-16|note: old comment<<} and this passage too.';

  it('anchors a Threadglyph thread inside old markup without confusing it with the plain copy', () => {
    const [legacy] = parseLegacyComments(note);
    const anchor = captureTextAnchor('thread-000001', 'n.md', note, legacy.from, legacy.to);
    expect(resolveTextAnchor(note, anchor)).toEqual({ status: 'found', from: legacy.from, to: legacy.to });
    const plain = note.lastIndexOf('this passage');
    const second = captureTextAnchor('thread-000002', 'n.md', note, plain, plain + 'this passage'.length);
    expect(resolveTextAnchor(note, second)).toEqual({ status: 'found', from: plain, to: plain + 'this passage'.length });
  });

  it('still finds the passage if the old plugin later removes its markup', () => {
    const [legacy] = parseLegacyComments(note);
    const anchor = captureTextAnchor('thread-000001', 'n.md', note, legacy.from, legacy.to);
    const stripped = 'Keep this passage and more text.';
    expect(resolveTextAnchor(stripped, anchor)).toMatchObject({ status: 'found' });
  });
});
