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
    expect(onOpen).toHaveBeenCalledWith('thread-open');
  });

  it('clears marks when given an empty set', () => {
    mount();
    view.dispatch({ effects: setThreadMarks.of([{ threadId: 'thread-a', from: 0, to: 4, resolved: false }]) });
    view.dispatch({ effects: setThreadMarks.of([]) });
    expect(view.dom.querySelector('.tg-anchor')).toBeNull();
    expect(view.dom.querySelector('.tg-glyph')).toBeNull();
  });
});
