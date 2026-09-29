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
      { ...base, quote: 'echo', imagePath: null, anchor: { kind: 'found', from: 5, to: 9 } },
      { ...base, quote: 'gone', imagePath: null, anchor: { kind: 'missing' } },
      { ...base, quote: null, imagePath: null, anchor: { kind: 'no-anchor' } },
    ];
    const text = 'abcd echo efg';
    expect(readingMarks(views, text)).toEqual([{ threadId: 't1', quote: 'echo', from: 5, number: 1, resolved: false }]);
  });
});

describe('Reading view image badges', () => {
  const src = 'Pics: ![[a.png]] ![[b.png|200]] ![[a.png]]\n';
  const html = '<p>Pics: <span class="internal-embed image-embed" src="a.png"><img></span> '
    + '<span class="internal-embed image-embed" src="b.png|200"><img></span> '
    + '<span class="internal-embed image-embed" src="a.png"><img></span></p>';
  const imageMark = (quote: string, nth: number, link: string): ReadingMark => {
    let from = -1;
    for (let i = 0; i <= nth; i++) from = src.indexOf(quote, from + 1);
    return { threadId: `img-${nth}-${link}`, quote, from, number: 7, resolved: false, imageLink: link };
  };

  it('badges the matching embed occurrence and outlines it', () => {
    const el = section(html);
    const onOpen = vi.fn();
    const marked = markRenderedSection(
      el,
      src,
      0,
      src.length,
      [imageMark('![[a.png]]', 1, 'a.png'), imageMark('![[b.png|200]]', 0, 'b.png')],
      onOpen,
    );
    expect(marked).toBe(2);
    const embeds = [...el.querySelectorAll<HTMLElement>('.internal-embed')];
    expect(embeds.map((e) => e.classList.contains('tg-image-anchor'))).toEqual([false, true, true]);
    expect(embeds[2].dataset.tgThread).toBe('img-1-a.png');
    const badge = embeds[2].nextElementSibling as HTMLElement;
    expect(badge.textContent).toBe('7');
    badge.click();
    expect(onOpen).toHaveBeenCalledWith('img-1-a.png');
  });

  it('skips embeds it cannot find and never badges one twice', () => {
    const el = section(html);
    expect(markRenderedSection(el, src, 0, src.length, [imageMark('![[a.png]]', 0, 'zzz.png')], vi.fn())).toBe(0);
    const twice = [imageMark('![[a.png]]', 0, 'a.png'), imageMark('![[a.png]]', 0, 'a.png')];
    expect(markRenderedSection(el, src, 0, src.length, twice, vi.fn())).toBe(1);
  });

  it('builds image marks with the link from the current source', () => {
    const base = { thread: { id: 't1', status: 'resolved' }, number: 2 } as unknown as ThreadView;
    const from = src.indexOf('![[b.png|200]]');
    const views: ThreadView[] = [
      { ...base, quote: 'old markup', imagePath: 'b.png', anchor: { kind: 'found', from, to: from + '![[b.png|200]]'.length } },
      { ...base, quote: 'x', imagePath: 'c.png', anchor: { kind: 'found', from: 0, to: 4 } },
    ];
    expect(readingMarks(views, src)).toEqual([
      { threadId: 't1', quote: '![[b.png|200]]', from, number: 2, resolved: true, imageLink: 'b.png' },
    ]);
  });
});
