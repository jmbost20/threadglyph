// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setThreadMarks, threadMarksExtension } from '../src/ui/editorMarks';

const doc = 'line one has a claim\nline two\nline three has two claims here\n';
let view: EditorView;

function mount(onOpen = vi.fn()) {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [threadMarksExtension(onOpen)] }),
    parent: document.body,
  });
  return onOpen;
}

const at = (s: string, from = 0) => doc.indexOf(s, from);

afterEach(() => {
  view.destroy();
  document.body.innerHTML = '';
});

describe('editor marks', () => {
  it('highlights anchored ranges and draws one glyph per line', () => {
    mount();
    const third = at('line three');
    view.dispatch({
      effects: setThreadMarks.of([
        { threadId: 'thread-a', from: at('claim'), to: at('claim') + 5, resolved: false },
        { threadId: 'thread-b', from: third + 15, to: third + 18, resolved: false },
        { threadId: 'thread-c', from: third + 23, to: third + 29, resolved: true },
        { threadId: 'bad-range', from: 5, to: 999, resolved: false },
      ]),
    });

    const anchors = [...view.dom.querySelectorAll<HTMLElement>('.tg-anchor')];
    expect(anchors.map((a) => a.dataset.tgThread)).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(view.dom.querySelectorAll('.tg-anchor-resolved')).toHaveLength(1);

    const glyphs = [...view.dom.querySelectorAll<HTMLElement>('.tg-gutter .tg-glyph')];
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0].getAttribute('aria-label')).toBe('Open thread');
    expect(glyphs[1].textContent).toBe('2');
    expect(glyphs[1].getAttribute('aria-label')).toBe('Open 2 threads');
  });

  it('keeps marks on their text while the user types above them', () => {
    mount();
    const from = at('line two');
    view.dispatch({ effects: setThreadMarks.of([{ threadId: 'thread-a', from, to: from + 8, resolved: false }]) });
    view.dispatch({ changes: { from: 0, insert: 'NEW TEXT\n' } });
    const anchor = view.dom.querySelector<HTMLElement>('.tg-anchor')!;
    expect(anchor.textContent).toBe('line two');
  });

  it('opens the open thread (before resolved ones) when its glyph is pressed', () => {
    const onOpen = mount();
    // happy-dom has no layout, so CodeMirror maps every gutter click to line 1; the marks live there.
    view.dispatch({
      effects: setThreadMarks.of([
        { threadId: 'thread-resolved', from: 0, to: 4, resolved: true },
        { threadId: 'thread-open', from: at('claim'), to: at('claim') + 5, resolved: false },
      ]),
    });
    const glyph = view.dom.querySelector<HTMLElement>('.tg-gutter .tg-glyph')!;
    glyph.closest('.cm-gutterElement')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith('thread-open', 'glyph');
  });

  it('draws a numbered badge after each passage that opens its thread without moving the caret', () => {
    const onOpen = mount();
    const from = at('claim');
    view.dispatch({
      effects: setThreadMarks.of([
        { threadId: 'thread-a', from, to: from + 5, resolved: false, number: 1, focused: true },
        { threadId: 'thread-b', from: at('line two'), to: at('line two') + 4, resolved: true, number: 2 },
      ]),
    });
    const badges = [...view.dom.querySelectorAll<HTMLElement>('.tg-badge')];
    expect(badges.map((b) => b.textContent)).toEqual(['1', '2']);
    expect(badges[0].closest('.cm-line')!.textContent).toBe('line one has a claim1');
    expect(badges[0].classList.contains('tg-badge-focused')).toBe(true);
    expect(badges[1].classList.contains('tg-badge-resolved')).toBe(true);
    expect(badges[0].getAttribute('aria-label')).toBe('Open thread 1');
    expect(view.dom.querySelector('.tg-anchor-focused')?.textContent).toBe('claim');

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    badges[0].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    badges[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onOpen).toHaveBeenCalledWith('thread-a', 'badge');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows a thread when its highlighted text is clicked, and ignores plain text', () => {
    const onOpen = mount();
    view.dispatch({ effects: setThreadMarks.of([{ threadId: 'thread-a', from: at('claim'), to: at('claim') + 5, resolved: false, number: 1 }]) });
    view.dom.querySelector<HTMLElement>('.tg-anchor')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith('thread-a', 'text');
    view.dom.querySelector<HTMLElement>('.cm-line')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('highlights a pending selection without a badge or a glyph', () => {
    mount();
    view.dispatch({ effects: setThreadMarks.of([{ threadId: '', from: 0, to: 4, resolved: false, pending: true, number: 9 }]) });
    const pending = view.dom.querySelector<HTMLElement>('.tg-anchor-pending')!;
    expect(pending.textContent).toBe('line');
    expect(pending.hasAttribute('data-tg-thread')).toBe(false);
    expect(view.dom.querySelector('.tg-badge')).toBeNull();
    expect(view.dom.querySelector('.tg-glyph')).toBeNull();
  });

  it('clears marks when given an empty set', () => {
    mount();
    view.dispatch({ effects: setThreadMarks.of([{ threadId: 'thread-a', from: 0, to: 4, resolved: false }]) });
    view.dispatch({ effects: setThreadMarks.of([]) });
    expect(view.dom.querySelector('.tg-anchor')).toBeNull();
    expect(view.dom.querySelector('.tg-glyph')).toBeNull();
  });
});
