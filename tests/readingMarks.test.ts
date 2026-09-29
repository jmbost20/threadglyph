// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { lineOffset, markRenderedSection, readingMarks, type ReadingMark } from '../src/ui/readingMarks';
import type { ThreadView } from '../src/ui/viewModel';

const source = '# Title\n\nSay it once: echo. Say it twice: echo.\n\nA **bold claim** and *mixed claim here*.\n';

function section(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function mark(quote: string, nth = 0, extra: Partial<ReadingMark> = {}): ReadingMark {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = source.indexOf(quote, from + 1);
  return { threadId: `thread-${quote.length}-${nth}`, quote, from, number: nth + 1, resolved: false, ...extra };
}

const para = (line: number) => [lineOffset(source, line), lineOffset(source, line + 1)] as const;

describe('Reading view highlights', () => {
  it('finds line offsets, clamping past the end', () => {
    expect(lineOffset(source, 0)).toBe(0);
    expect(lineOffset(source, 2)).toBe(source.indexOf('Say'));
    expect(lineOffset(source, 99)).toBe(source.length);
  });

  it('wraps the same occurrence the anchor points to, with a numbered badge', () => {
    const el = section('<p>Say it once: echo. Say it twice: echo.</p>');
    const onOpen = vi.fn();
    const marked = markRenderedSection(el, source, ...para(2), [mark('echo', 1)], onOpen);
    expect(marked).toBe(1);
    const anchor = el.querySelector<HTMLElement>('.tg-anchor')!;
    expect(anchor.dataset.tgThread).toBe('thread-4-1');
    expect(anchor.previousSibling?.textContent).toBe('Say it once: echo. Say it twice: ');
    const badge = anchor.nextElementSibling as HTMLElement;
    expect(badge.className).toBe('tg-badge');
    expect(badge.textContent).toBe('2');
    expect(el.textContent).toBe('Say it once: echo. Say it twice: echo2.');

    badge.click();
    badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    anchor.click();
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledWith('thread-4-1');
  });

  it('marks both threads on a repeated quote, whatever order they arrive in (Gitar review on PR #3)', () => {
    for (const order of [[0, 1], [1, 0]]) {
      const el = section('<p>Say it once: echo. Say it twice: echo.</p>');
      const marks = order.map((nth) => mark('echo', nth));
      expect(markRenderedSection(el, source, ...para(2), marks, vi.fn())).toBe(2);
      expect([...el.querySelectorAll<HTMLElement>('.tg-anchor')].map((a) => a.dataset.tgThread)).toEqual([
        'thread-4-0',
        'thread-4-1',
      ]);
    }
  });

  it('marks text inside formatting and styles resolved threads', () => {
    const el = section('<p>A <strong>bold claim</strong> and <em>mixed claim here</em>.</p>');
    const marked = markRenderedSection(el, source, ...para(4), [mark('bold claim', 0, { resolved: true })], vi.fn());
    expect(marked).toBe(1);
    expect(el.querySelector('strong .tg-anchor-resolved')?.textContent).toBe('bold claim');
    expect(el.querySelector('.tg-badge-resolved')).not.toBeNull();
  });

  it('skips anchors outside the section and quotes split across formatting', () => {
    const el = section('<p>A <strong>bold claim</strong> and <em>mixed claim here</em>.</p>');
    const across = { ...mark('claim and *mixed'), quote: 'claim and mixed' };
    const marked = markRenderedSection(el, source, ...para(4), [mark('echo'), across], vi.fn());
    expect(marked).toBe(0);
    expect(el.querySelector('.tg-anchor')).toBeNull();
  });

  it('builds marks only for anchors that were found', () => {
    const base = { thread: { id: 't1', status: 'open' }, number: 1 } as unknown as ThreadView;
    const views: ThreadView[] = [
      { ...base, quote: 'echo', anchor: { kind: 'found', from: 5, to: 9 } },
      { ...base, quote: 'gone', anchor: { kind: 'missing' } },
      { ...base, quote: null, anchor: { kind: 'no-anchor' } },
    ];
    expect(readingMarks(views)).toEqual([{ threadId: 't1', quote: 'echo', from: 5, number: 1, resolved: false }]);
  });
});
