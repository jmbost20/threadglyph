// @vitest-environment happy-dom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
// Same module the 'obsidian' alias resolves to for src/main.ts.
import { FakeApp, TFile, notices, openModals, type MarkdownView } from './obsidianStub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadglyphPlugin, { destination } from '../src/main';
import { addReply } from '../src/model/thread';
import type { ThreadRecord } from '../src/model/types';
import type { AiAdapter, AiRequest, AiResult } from '../src/ai/types';
import { DEFAULT_AI_SETTINGS } from '../src/ai/assistants';
import { ANCHORS_DIR, THREADS_DIR } from '../src/storage/paths';
import type { PanelActions } from '../src/ui/ThreadPanel';

type Fake = InstanceType<typeof FakeApp>;

const NOTE = 'Daily/2026-09-28.md';
const NOTE_TEXT = 'Morning pages.\nA sentence worth a comment.\nEvening.\n';

let app: Fake;
let plugin: ThreadglyphPlugin;
let view: MarkdownView & { editor: { selection: [number, number]; cm?: EditorView; scrolled: unknown } };

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const files = (dir: string) => [...app.vault.adapter.files.keys()].filter((p) => p.startsWith(`${dir}/`));
const threads = (): ThreadRecord[] => files(THREADS_DIR).map((p) => JSON.parse(app.vault.adapter.files.get(p)!));
const panelEl = () => document.querySelector<HTMLElement>('.tg-panel')!;
const q = <T extends HTMLElement = HTMLElement>(sel: string) => panelEl()?.querySelector<T>(sel) ?? null;
const expandAll = () => {
  for (let head = q<HTMLElement>('.tg-ai-group[aria-expanded="false"]'); head; head = q<HTMLElement>('.tg-ai-group[aria-expanded="false"]')) head.click();
};
const button = (label: string) =>
  [...panelEl().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const command = (id: string) => (plugin as unknown as { commands: { id: string; editorCheckCallback?: (...a: unknown[]) => boolean; callback?: () => void }[] }).commands.find((c) => c.id === id)!;
const panelActions = () => (plugin as unknown as { panelActions(): PanelActions }).panelActions();
const select = (text: string) => {
  const from = NOTE_TEXT.indexOf(text);
  view.editor.selection = [from, from + text.length];
};

async function commentOn(text: string, body: string) {
  select(text);
  command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
  await flush();
  const input = q<HTMLTextAreaElement>('.tg-card-new textarea')!;
  input.value = body;
  input.dispatchEvent(new Event('input'));
  button('Comment')!.click();
  await flush();
}

beforeEach(async () => {
  notices.length = 0;
  app = new FakeApp();
  app.vault.adapter.files.set(NOTE, NOTE_TEXT);
  app.vault.adapter.files.set('Other.md', 'Unrelated note.\n');
  view = app.workspace.open(NOTE) as typeof view;
  plugin = new ThreadglyphPlugin(app as never, {} as never);
  await plugin.onload();
  await flush();
  // Attach a real CodeMirror editor so highlight dispatches can be observed.
  view.editor.cm = new EditorView({
    state: EditorState.create({ doc: NOTE_TEXT, extensions: (plugin as unknown as { extensions: Extension[] }).extensions }),
    parent: document.body,
  });
});

afterEach(() => {
  plugin.onunload();
  view.editor.cm?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Threadglyph plugin (Obsidian wiring)', () => {
  it('offers "Comment on selection" only when text is selected in a file', () => {
    const cmd = command('comment-on-selection');
    expect(cmd.editorCheckCallback!(true, view.editor, view)).toBe(false);
    select('worth');
    expect(cmd.editorCheckCallback!(true, view.editor, view)).toBe(true);
    expect(cmd.editorCheckCallback!(true, view.editor, { file: null })).toBe(false);
  });

  it('creates a thread from a selection without touching the note, and keeps quotes out of tracked files', async () => {
    await commentOn('worth a comment', 'Why this phrase?');

    expect(app.vault.adapter.files.get(NOTE)).toBe(NOTE_TEXT);
    const [thread] = threads();
    expect(thread).toMatchObject({ notePath: NOTE, messages: [{ body: 'Why this phrase?', author: { name: 'Me' } }] });
    expect(JSON.stringify(thread)).not.toContain('worth a comment');
    expect(files(ANCHORS_DIR)).toHaveLength(1);
    expect(app.vault.adapter.files.get(files(ANCHORS_DIR)[0])).toContain('worth a comment');

    expect(q('.tg-quote-link')?.textContent).toBe('worth a comment');
    expect(q('.tg-header-title')?.textContent).toBe('2026-09-28');
    const highlight = view.editor.cm!.dom.querySelector('.tg-anchor');
    expect(highlight?.textContent).toBe('worth a comment');
  });

  it('reports an unusable selection instead of opening a card', async () => {
    view.editor.selection = [NOTE_TEXT.indexOf('\n'), NOTE_TEXT.indexOf('\n') + 1];
    command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
    await flush();
    expect(notices.at(-1)).toMatch(/Select some text/);
    expect(q('.tg-card-new')).toBeNull();
  });

  it('adds a context-menu item for selections only', async () => {
    const items: { title?: string; click?: () => void }[] = [];
    const menu = {
      addItem: (build: (item: unknown) => void) => {
        const item: { title?: string; click?: () => void } = {};
        const api = {
          setTitle: (t: string) => ((item.title = t), api),
          setIcon: () => api,
          setSection: () => api,
          onClick: (cb: () => void) => ((item.click = cb), api),
        };
        build(api);
        items.push(item);
      },
    };
    app.workspace.trigger('editor-menu', menu, view.editor, view);
    expect(items).toHaveLength(0);
    select('Evening');
    app.workspace.trigger('editor-menu', menu, view.editor, view);
    expect(items[0].title).toMatch(/comment on selection/);
    items[0].click!();
    await flush();
    expect(q('.tg-card-new .tg-quote')?.textContent).toBe('Evening');
  });

  it('follows a note rename in the stored record and anchor', async () => {
    await commentOn('worth a comment', 'Track me');
    app.vault.adapter.files.set('Journal/renamed.md', NOTE_TEXT);
    app.vault.adapter.files.delete(NOTE);
    app.vault.trigger('rename', new TFile('Journal/renamed.md'), NOTE);
    await flush();
    expect(threads()[0].notePath).toBe('Journal/renamed.md');
    expect(JSON.parse(app.vault.adapter.files.get(files(ANCHORS_DIR)[0])!).notePath).toBe('Journal/renamed.md');
  });

  it('ignores renames of its own thread files', async () => {
    await commentOn('worth a comment', 'Stay');
    const store = (plugin as unknown as { store: { renameNote: (...a: unknown[]) => Promise<string[]> } }).store;
    const rename = vi.spyOn(store, 'renameNote');
    const before = new Map(app.vault.adapter.files);
    // Into, out of, and within the thread folder: none of these are note renames.
    app.vault.trigger('rename', new TFile(`${THREADS_DIR}/x-renamed-1.json`), `${THREADS_DIR}/x-original-1.json`);
    app.vault.trigger('rename', new TFile(`${THREADS_DIR}/moved-in-1.json`), 'Elsewhere/moved-in-1.json');
    app.vault.trigger('rename', new TFile('Elsewhere/moved-out-1.json'), `${THREADS_DIR}/moved-out-1.json`);
    await flush();
    expect(rename).not.toHaveBeenCalled();
    expect(app.vault.adapter.files).toEqual(before);

    app.vault.trigger('rename', new TFile('Other-renamed.md'), 'Other.md');
    await flush();
    expect(rename).toHaveBeenCalledWith('Other.md', 'Other-renamed.md');
  });

  it('reloads a thread changed on disk by another device', async () => {
    await commentOn('worth a comment', 'Original');
    const [thread] = threads();
    const path = files(THREADS_DIR)[0];
    app.vault.adapter.files.set(path, JSON.stringify(addReply(thread, { kind: 'human', name: 'Phone' }, 'From my phone')));
    app.vault.trigger('modify', new TFile(path));
    await flush();
    expect([...panelEl().querySelectorAll('.tg-message-body')].map((e) => e.textContent)).toEqual([
      'Original',
      'From my phone',
    ]);
  });

  it('drops a thread whose file was deleted, and picks up one created elsewhere', async () => {
    await commentOn('worth a comment', 'Soon gone');
    const [thread] = threads();
    const path = files(THREADS_DIR)[0];
    app.vault.adapter.files.delete(path);
    app.vault.trigger('delete', new TFile(path));
    await flush();
    expect(q('.tg-message-body')).toBeNull();

    app.vault.adapter.files.set(path, JSON.stringify(thread));
    app.vault.trigger('create', new TFile(path));
    await flush();
    expect(q('.tg-message-body')?.textContent).toBe('Soon gone');
  });

  it('refreshes highlights when an annotated note changes, and ignores unrelated notes', async () => {
    await commentOn('worth a comment', 'Watch me');
    const refresh = vi.spyOn(plugin, 'refresh');
    app.vault.trigger('modify', new TFile('Other.md'));
    expect(refresh).not.toHaveBeenCalled();
    app.vault.trigger('modify', new TFile(NOTE));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows a notice and keeps the draft when saving fails on disk', async () => {
    await commentOn('worth a comment', 'First');
    const [thread] = threads();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    app.vault.adapter.write = () => Promise.reject(new Error('disk full'));
    const reply = q<HTMLTextAreaElement>(`textarea[data-draft-key="reply:${thread.id}"]`)!;
    reply.value = 'Do not lose me';
    reply.dispatchEvent(new Event('input'));
    button('Reply')!.click();
    await flush();
    expect(notices.at(-1)).toBe('Threadglyph could not save: disk full. Your text is kept.');
    expect(q<HTMLTextAreaElement>(`textarea[data-draft-key="reply:${thread.id}"]`)!.value).toBe('Do not lose me');
  });

  it('reports a stale edit through a notice', async () => {
    await commentOn('worth a comment', 'Mine');
    const [thread] = threads();
    ([...panelEl().querySelectorAll<HTMLButtonElement>('.tg-message-action')].find((b) => b.textContent === 'Edit')!).click();
    await flush();
    const path = files(THREADS_DIR)[0];
    const edited = { ...thread, revision: 2, messages: [{ ...thread.messages[0], body: 'Changed on phone' }] };
    app.vault.adapter.files.set(path, JSON.stringify(edited));
    app.vault.trigger('modify', new TFile(path));
    await flush();
    const input = q<HTMLTextAreaElement>(`textarea[data-draft-key="edit:${thread.id}:${thread.messages[0].id}"]`)!;
    input.value = 'My edit';
    input.dispatchEvent(new Event('input'));
    button('Save')!.click();
    await flush();
    expect(notices.at(-1)).toMatch(/changed elsewhere/);
    expect(threads()[0].messages[0].body).toBe('Changed on phone');
  });

  it('navigates to the passage, and warns when it cannot', async () => {
    await commentOn('worth a comment', 'Go there');
    view.editor.selection = [0, 0];
    q<HTMLButtonElement>('.tg-quote-link')!.click();
    await flush();
    const from = NOTE_TEXT.indexOf('worth a comment');
    expect(view.editor.selection).toEqual([from, from + 'worth a comment'.length]);
    expect(view.editor.scrolled).toEqual({ from: { offset: from }, to: { offset: from + 15 } });

    // The note is edited so the quote disappears before navigation.
    app.vault.adapter.files.set(NOTE, 'Rewritten.\n');
    const [thread] = threads();
    await (plugin as unknown as { goTo(id: string): Promise<void> }).goTo(thread.id);
    expect(notices.at(-1)).toMatch(/could not be located/);

    app.vault.adapter.files.delete(NOTE);
    await (plugin as unknown as { goTo(id: string): Promise<void> }).goTo(thread.id);
    expect(notices.at(-1)).toMatch(/note for this thread is missing/);
  });

  it('panel navigation highlights the passage but leaves the keyboard in the panel', async () => {
    await commentOn('worth a comment', 'Stay in panel');
    const [thread] = threads();
    const focus = vi.spyOn(app.workspace, 'setActiveLeaf');
    const reveal = (plugin as unknown as { revealPassage(id: string, focusEditor: boolean): Promise<void> }).revealPassage.bind(plugin);
    await reveal(thread.id, false);
    const from = NOTE_TEXT.indexOf('worth a comment');
    expect(view.editor.selection).toEqual([from, from + 15]);
    expect(focus).not.toHaveBeenCalled();
    // A lost passage is still stepped onto, without a notice. Clear the focus first,
    // so the check proves this second call set it (Gitar on #9).
    app.vault.adapter.files.set(NOTE, 'Rewritten.\n');
    const focused = plugin as unknown as { focusedThreadId: string | null };
    focused.focusedThreadId = null;
    const before = notices.length;
    await reveal(thread.id, false);
    expect(notices).toHaveLength(before);
    expect(focused.focusedThreadId).toBe(thread.id);
  });

  it('opens a closed note before navigating to its passage', async () => {
    await commentOn('worth a comment', 'Reopen');
    app.workspace.leaves = app.workspace.leaves.filter((l) => l.view !== view);
    const [thread] = threads();
    await (plugin as unknown as { goTo(id: string): Promise<void> }).goTo(thread.id);
    const reopened = app.workspace.getLeavesOfType('markdown')[0].view as typeof view;
    const from = NOTE_TEXT.indexOf('worth a comment');
    expect(reopened.editor.selection).toEqual([from, from + 15]);
  });

  it('reattaches a lost anchor to the current selection', async () => {
    await commentOn('worth a comment', 'Reattach me');
    const reworded = 'Morning pages.\nA reworded sentence.\nEvening.\n';
    app.vault.adapter.files.set(NOTE, reworded);
    await plugin.refresh();
    expect(q('.tg-anchor-problem')).not.toBeNull();

    view.editor.selection = [0, 0];
    button('Reattach to selection')!.click();
    await flush();
    expect(notices.at(-1)).toMatch(/Select the passage/);

    const start = reworded.indexOf('A reworded sentence');
    view.editor.selection = [start, start + 'A reworded sentence'.length];
    button('Reattach to selection')!.click();
    await flush();
    expect(q('.tg-anchor-problem')).toBeNull();
    expect(q('.tg-quote-link')?.textContent).toBe('A reworded sentence');
    expect(threads()[0].messages[0].body).toBe('Reattach me');
  });

  it('opens and focuses a resolved thread from its margin glyph', async () => {
    // happy-dom has no layout, so the gutter maps every click to line 1; anchor the thread there.
    await commentOn('Morning pages', 'Resolve then find');
    button('Resolve')!.click();
    await flush();
    expect(q('.tg-card-resolved')).toBeNull();

    const glyph = view.editor.cm!.dom.querySelector<HTMLElement>('.tg-gutter .tg-glyph-resolved')!;
    glyph.closest('.cm-gutterElement')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flush();
    expect(q('.tg-card-resolved.tg-card-focused')).not.toBeNull();
  });

  it('deletes and restores a comment, then the whole thread, from the panel', async () => {
    await commentOn('worth a comment', 'First');
    const id = threads()[0].id;
    const actions = panelActions();
    expect(await actions.reply(id, 'Second')).toBe(true);
    const second = threads()[0].messages[1].id;
    expect(await actions.setMessageDeleted(id, second, true)).toBe(true);
    expect(threads()[0].messages[1].deletedAt).toBeTruthy();
    expect(await actions.setMessageDeleted(id, second, false)).toBe(true);
    expect(threads()[0].messages[1].deletedAt).toBeFalsy();
    expect(await actions.setThreadDeleted(id, true)).toBe(true);
    expect(threads()[0].messages.every((m) => m.deletedAt)).toBe(true);
    expect(await actions.setThreadDeleted(id, false)).toBe(true);
    expect(threads()[0].messages.some((m) => m.deletedAt)).toBe(false);
    expect(app.vault.adapter.files.get(NOTE)).toBe(NOTE_TEXT);
  });

  it('selects a passage from the panel, and refreshes on file-open, leaf changes and unrelated deletes', async () => {
    await commentOn('worth a comment', 'Look');
    await panelActions().select(threads()[0].id);
    const from = NOTE_TEXT.indexOf('worth a comment');
    expect(view.editor.selection).toEqual([from, from + 15]);
    const refresh = vi.spyOn(plugin, 'refresh');
    app.workspace.trigger('file-open');
    app.workspace.trigger('active-leaf-change');
    app.vault.trigger('delete', new TFile('Other.md'));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('handles panel actions: cancel, edit and cancel edit, resolve toggle, reopen', async () => {
    select('Evening');
    command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
    await flush();
    button('Cancel')!.click();
    await flush();
    expect(q('.tg-card-new')).toBeNull();

    await commentOn('worth a comment', 'Edit me');
    ([...panelEl().querySelectorAll<HTMLButtonElement>('.tg-message-action')].find((b) => b.textContent === 'Edit')!).click();
    await flush();
    button('Cancel')!.click();
    await flush();
    expect(q('.tg-card textarea[data-draft-key^="edit:"]')).toBeNull();

    ([...panelEl().querySelectorAll<HTMLButtonElement>('.tg-message-action')].find((b) => b.textContent === 'Edit')!).click();
    await flush();
    const input = q<HTMLTextAreaElement>('textarea[data-draft-key^="edit:"]')!;
    input.value = 'Edited';
    input.dispatchEvent(new Event('input'));
    button('Save')!.click();
    await flush();
    expect(threads()[0].messages[0].body).toBe('Edited');

    button('Resolve')!.click();
    await flush();
    button('Resolved')!.click();
    await flush();
    button('Reopen')!.click();
    await flush();
    expect(threads()[0].status).toBe('open');
  });

  it('numbers highlights with badges and marks the pending selection', async () => {
    select('Evening');
    command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
    await flush();
    expect(view.editor.cm!.dom.querySelector('.tg-anchor-pending')?.textContent).toBe('Evening');
    button('Cancel')!.click();
    await flush();
    expect(view.editor.cm!.dom.querySelector('.tg-anchor-pending')).toBeNull();

    await commentOn('Evening', 'Second in reading order');
    await commentOn('worth a comment', 'First in reading order');
    const badges = [...view.editor.cm!.dom.querySelectorAll<HTMLElement>('.tg-badge')];
    expect(badges.map((b) => b.textContent)).toEqual(['1', '2']);
    expect([...panelEl().querySelectorAll('.tg-card-number')].map((b) => b.textContent)).toEqual(['1', '2']);
  });

  it('opens a thread from its badge (focusing the reply) and from its text (keeping focus in the note)', async () => {
    await commentOn('worth a comment', 'Badge me');
    const { ThreadPanel } = await import('../src/ui/ThreadPanel');
    const scroll = vi.spyOn(ThreadPanel.prototype, 'scrollToThread');
    const cm = view.editor.cm!;
    const id = threads()[0].id;

    cm.dom.querySelector<HTMLElement>('.tg-anchor')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(scroll).toHaveBeenLastCalledWith(id, false);
    expect(q('.tg-card-focused')).not.toBeNull();
    expect(cm.dom.querySelector('.tg-anchor-focused')).not.toBeNull();

    cm.dom.querySelector<HTMLElement>('.tg-badge')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(scroll).toHaveBeenLastCalledWith(id, true);
  });

  it('steps through threads in the note, wrapping at either end', async () => {
    const next = command('next-thread').editorCheckCallback!;
    const previous = command('previous-thread').editorCheckCallback!;
    expect(next(true, view.editor, view)).toBe(false);
    await commentOn('Morning', 'one');
    await commentOn('Evening', 'two');
    expect(next(true, view.editor, view)).toBe(true);
    expect(next(true, view.editor, { file: null })).toBe(false);

    const at = (s: string) => [NOTE_TEXT.indexOf(s), NOTE_TEXT.indexOf(s) + s.length];
    view.editor.selection = [0, 0];
    next(false, view.editor, view);
    expect(view.editor.selection).toEqual(at('Evening'));
    next(false, view.editor, view);
    expect(view.editor.selection).toEqual(at('Morning'));
    previous(false, view.editor, view);
    expect(view.editor.selection).toEqual(at('Evening'));
    previous(false, view.editor, view);
    expect(view.editor.selection).toEqual(at('Morning'));
    await flush();
    expect(q('.tg-card-focused .tg-quote-link')?.textContent).toBe('Morning');
  });

  it('visits every thread when two start at the same place, in both directions', async () => {
    await commentOn('Morning', 'short');
    await commentOn('Morning pages', 'long');
    await commentOn('Evening', 'last');
    const next = command('next-thread').editorCheckCallback!;
    const previous = command('previous-thread').editorCheckCallback!;
    const at = (s: string) => [NOTE_TEXT.indexOf(s), NOTE_TEXT.indexOf(s) + s.length];
    const visits = (step: typeof next) => Array.from({ length: 3 }, () => {
      step(false, view.editor, view);
      return NOTE_TEXT.slice(view.editor.selection[0], view.editor.selection[1]);
    });

    view.editor.selection = at('Evening') as [number, number];
    expect(visits(next)).toEqual(['Morning', 'Morning pages', 'Evening']);
    expect(visits(previous)).toEqual(['Morning pages', 'Morning', 'Evening']);
    // From a plain cursor (not on a passage), previous goes to the nearest passage before it, wrapping at the top.
    view.editor.selection = [NOTE_TEXT.indexOf('Evening') - 1, NOTE_TEXT.indexOf('Evening') - 1];
    expect(visits(previous)[0]).toBe('Morning pages');
    view.editor.selection = [0, 0];
    expect(visits(previous)[0]).toBe('Evening');
  });

  it('tells apart two threads on exactly the same passage by the one in focus', async () => {
    await commentOn('Evening', 'first');
    await commentOn('Evening', 'second');
    await commentOn('Morning', 'other');
    const next = command('next-thread').editorCheckCallback!;
    const focused = () => q('.tg-card-focused .tg-message-body')?.textContent;
    const seen: string[] = [];
    view.editor.selection = [0, 0];
    for (let i = 0; i < 3; i++) {
      next(false, view.editor, view);
      await flush();
      seen.push(focused()!);
    }
    expect(new Set(seen)).toEqual(new Set(['first', 'second', 'other']));
  });

  it('replies to the thread under the cursor', async () => {
    const reply = command('reply-at-cursor').editorCheckCallback!;
    await commentOn('worth a comment', 'Under the cursor');
    const { ThreadPanel } = await import('../src/ui/ThreadPanel');
    const scroll = vi.spyOn(ThreadPanel.prototype, 'scrollToThread');
    const inside = NOTE_TEXT.indexOf('a comment');
    view.editor.selection = [inside, inside];
    expect(reply(true, view.editor, view)).toBe(true);
    reply(false, view.editor, view);
    await flush();
    expect(scroll).toHaveBeenLastCalledWith(threads()[0].id, true);

    view.editor.selection = [0, 0];
    expect(reply(true, view.editor, view)).toBe(false);
    expect(reply(true, view.editor, { file: null })).toBeFalsy();
  });

  it('highlights passages in Reading view and re-renders it only when threads change', async () => {
    const processor = (plugin as unknown as { postProcessors: ((el: HTMLElement, ctx: unknown) => void)[] }).postProcessors[0];
    const render = (sectionInfo: unknown) => {
      const el = document.createElement('div');
      el.innerHTML = '<p>A sentence worth a comment.</p>';
      processor(el, { sourcePath: NOTE, getSectionInfo: () => sectionInfo });
      return el;
    };
    const info = { text: NOTE_TEXT, lineStart: 1, lineEnd: 1 };
    expect(render(info).querySelector('.tg-anchor')).toBeNull();

    view.mode = 'preview';
    await commentOn('worth a comment', 'In reading view');
    const rerenders = view.previewMode.rerenders;
    expect(rerenders).toBeGreaterThan(0);
    const el = render(info);
    expect(el.querySelector('.tg-anchor')?.textContent).toBe('worth a comment');
    expect(el.querySelector('.tg-badge')?.textContent).toBe('1');
    expect(render(null).querySelector('.tg-anchor')).toBeNull();

    el.querySelector<HTMLElement>('.tg-badge')!.click();
    await flush();
    expect(q('.tg-card-focused')).not.toBeNull();
    expect(view.previewMode.rerenders).toBe(rerenders);
  });

  it('takes its Reading view marks out when the plugin unloads', async () => {
    const processor = (plugin as unknown as { postProcessors: ((el: HTMLElement, ctx: unknown) => void)[] }).postProcessors[0];
    view.mode = 'preview';
    await commentOn('worth a comment', 'Before unload');
    document.body.appendChild(view.containerEl); // as in Obsidian, the view is part of the page
    const preview = view.containerEl.createDiv({ cls: 'markdown-preview-view' });
    const original = '<p>A sentence worth a comment.</p>';
    preview.innerHTML = original;
    processor(preview, { sourcePath: NOTE, getSectionInfo: () => ({ text: NOTE_TEXT, lineStart: 1, lineEnd: 1 }) });
    expect(preview.querySelector('.tg-badge')).not.toBeNull();
    // A note card on a Canvas or a hover preview, outside any markdown leaf.
    const card = document.body.createDiv({ cls: 'markdown-rendered' });
    card.innerHTML = original;
    processor(card, { sourcePath: NOTE, getSectionInfo: () => ({ text: NOTE_TEXT, lineStart: 1, lineEnd: 1 }) });
    expect(card.querySelector('.tg-badge')).not.toBeNull();

    plugin.onunload();
    expect(preview.innerHTML).toBe(original);
    expect(card.innerHTML).toBe(original);
  });

  it('re-renders a Reading pane of a note that is also open in an editor (Gitar review on PR #3)', async () => {
    // The editor pane comes first in the leaf list, as in the reported case.
    const reading = app.workspace.open(NOTE) as typeof view;
    reading.mode = 'preview';
    await commentOn('worth a comment', 'Two panes');
    const afterCreate = reading.previewMode.rerenders;
    expect(afterCreate).toBeGreaterThan(0);
    expect(view.previewMode.rerenders).toBe(0);

    // Resolving changes the marks, so the Reading pane re-renders again; the source pane never does.
    button('Resolve')!.click();
    await flush();
    expect(reading.previewMode.rerenders).toBeGreaterThan(afterCreate);
    expect(view.previewMode.rerenders).toBe(0);

    // A pane switched to Reading later gets its own first render with the current marks.
    view.mode = 'preview';
    await plugin.refresh();
    expect(view.previewMode.rerenders).toBe(1);
  });

  it('shows loading-free empty states and the open-panel command', async () => {
    app.workspace.activeFile = null;
    app.workspace.leaves = app.workspace.leaves.filter((l) => l.view !== view);
    (plugin as unknown as { currentFile: null }).currentFile = null;
    command('open-panel').callback!();
    await flush();
    expect(q('.tg-empty')?.textContent).toMatch(/Open a note/);
    (plugin as unknown as { ribbon: (() => void)[] }).ribbon[0]();
    await flush();
    expect(app.workspace.getLeavesOfType('threadglyph-panel')).toHaveLength(1);
  });

  it('saves the author name setting, falling back to the default when blank', async () => {
    const tab = (plugin as unknown as { settingTabs: { display(): void; containerEl: HTMLElement }[] }).settingTabs[0];
    tab.display();
    const input = tab.containerEl.querySelector('input')!;
    expect(input.value).toBe('Me');
    input.value = '  Jonah  ';
    input.dispatchEvent(new Event('input'));
    await flush();
    expect(plugin.settings.authorName).toBe('Jonah');
    expect((plugin as unknown as { data: unknown }).data).toEqual({ ...DEFAULT_AI_SETTINGS, authorName: 'Jonah' });
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    await flush();
    expect(plugin.settings.authorName).toBe('Me');

    await commentOn('worth a comment', 'Signed');
    expect(threads()[0].messages[0].author.name).toBe('Me');
  });

  it('loads saved settings on startup', async () => {
    const again = new ThreadglyphPlugin(app as never, {} as never);
    (again as unknown as { data: unknown }).data = { authorName: 'Saved Name' };
    await again.loadSettings();
    expect(again.settings.authorName).toBe('Saved Name');
  });
});

describe('Threadglyph plugin image threads', () => {
  const TRIP = 'Trips/Coast.md';
  const TRIP_TEXT = 'Day one.\n![[view.png]]\n![](https://example.com/far.png) ![[scan.heic]] ![[lost.png]]\nEnd.\n';
  let trip: typeof view;

  beforeEach(() => {
    app.vault.adapter.files.set(TRIP, TRIP_TEXT);
    app.vault.adapter.files.set('Attachments/view.png', 'png bytes');
    app.vault.adapter.files.set('Attachments/scan.heic', 'heic bytes');
    trip = app.workspace.open(TRIP) as typeof view;
  });

  const cursorOn = (markup: string, offset = 2) => {
    const at = TRIP_TEXT.indexOf(markup) + offset;
    trip.editor.selection = [at, at];
  };
  const run = async () => {
    command('comment-on-selection').editorCheckCallback!(false, trip.editor, trip);
    await flush();
  };

  it('comments on the image under the cursor and previews it', async () => {
    trip.editor.selection = [1, 1];
    expect(command('comment-on-selection').editorCheckCallback!(true, trip.editor, trip)).toBe(false);
    cursorOn('![[view.png]]');
    expect(command('comment-on-selection').editorCheckCallback!(true, trip.editor, trip)).toBe(true);
    await run();
    expect(q('.tg-card-new img')?.getAttribute('src')).toBe('app://local/Attachments/view.png');

    const input = q<HTMLTextAreaElement>('.tg-card-new textarea')!;
    input.value = 'What a view';
    input.dispatchEvent(new Event('input'));
    button('Comment')!.click();
    await flush();
    const [thread] = threads();
    expect(thread.anchorKind).toBe('image');
    expect(JSON.stringify(thread)).not.toContain('view.png');
    const anchor = JSON.parse(app.vault.adapter.files.get(files(ANCHORS_DIR)[0])!);
    expect(anchor).toMatchObject({ kind: 'image', imagePath: 'Attachments/view.png', quote: '![[view.png]]' });
    expect(app.vault.adapter.files.get(TRIP)).toBe(TRIP_TEXT);
  });

  it('labels the context-menu item for images', () => {
    const titles: string[] = [];
    const menu = {
      addItem: (build: (item: unknown) => void) => {
        const api = { setTitle: (t: string) => (titles.push(t), api), setIcon: () => api, setSection: () => api, onClick: () => api };
        build(api);
      },
    };
    cursorOn('![[view.png]]');
    app.workspace.trigger('editor-menu', menu, trip.editor, trip);
    expect(titles).toEqual(['Threadglyph: comment on image']);
  });

  it('comments on text when the selection only contains an image', async () => {
    trip.editor.selection = [0, TRIP_TEXT.indexOf('![[view.png]]') + 14];
    await run();
    expect(q('.tg-card-new .tg-image')).toBeNull();
    expect(q('.tg-card-new .tg-quote')?.textContent).toContain('Day one.');
  });

  it('explains remote, unsupported and missing images', async () => {
    cursorOn('![](https://example.com/far.png)');
    await run();
    expect(notices.at(-1)).toMatch(/does not fetch remote images/);
    cursorOn('![[scan.heic]]');
    await run();
    expect(notices.at(-1)).toMatch(/HEIC images are not supported yet/);
    cursorOn('![[lost.png]]');
    await run();
    expect(notices.at(-1)).toBe('Image file not found in this vault: lost.png');
    expect(q('.tg-card-new')).toBeNull();
  });

  it('follows the image through a rename and reattaches only to an image', async () => {
    cursorOn('![[view.png]]');
    await run();
    const input = q<HTMLTextAreaElement>('.tg-card-new textarea')!;
    input.value = 'Keep me';
    input.dispatchEvent(new Event('input'));
    button('Comment')!.click();
    await flush();

    app.vault.adapter.files.set('Attachments/vista.png', 'png bytes');
    app.vault.adapter.files.delete('Attachments/view.png');
    app.vault.trigger('rename', new TFile('Attachments/vista.png'), 'Attachments/view.png');
    await flush();
    const anchorFile = () => JSON.parse(app.vault.adapter.files.get(files(ANCHORS_DIR)[0])!);
    expect(anchorFile().imagePath).toBe('Attachments/vista.png');

    trip.editor.selection = [0, 3];
    await (plugin as unknown as { reattach(id: string): Promise<void> }).reattach(threads()[0].id);
    expect(notices.at(-1)).toMatch(/Put the cursor on the image embed/);

    cursorOn('![[lost.png]]');
    await (plugin as unknown as { reattach(id: string): Promise<void> }).reattach(threads()[0].id);
    expect(notices.at(-1)).toBe('Image file not found in this vault: lost.png');

    app.vault.adapter.files.set('Attachments/lost.png', 'png bytes');
    await (plugin as unknown as { reattach(id: string): Promise<void> }).reattach(threads()[0].id);
    expect(anchorFile()).toMatchObject({ imagePath: 'Attachments/lost.png', quote: '![[lost.png]]' });
    expect(threads()[0].messages[0].body).toBe('Keep me');
  });
});

describe('Threadglyph plugin AI', () => {
  let requests: AiRequest[];
  let answers: AiResult[];

  beforeEach(() => {
    requests = [];
    answers = [];
    const adapter: AiAdapter = {
      id: 'claude',
      name: 'Claude',
      detail: 'test-model',
      egress: 'cloud',
      capabilities: { text: true, images: true },
      ask: async (request) => {
        requests.push(request);
        return answers.shift() ?? { ok: true, text: 'A synthetic reply.' };
      },
    };
    plugin.adapterFactory = (settings) => (settings.aiEnabled ? [adapter] : []);
  });

  const enable = async () => {
    plugin.settings.aiEnabled = true;
    await plugin.refresh();
  };

  it('shows no AI controls until enabled, and @Claude does nothing while off', async () => {
    await commentOn('worth a comment', 'Hey @Claude');
    expect(button('Ask AI')).toBeUndefined();
    expect(q('.tg-ai')).toBeNull();
    await enable();
    expect(button('Ask AI')).toBeDefined();
  });

  it('opens a preview when a new comment mentions @Claude, and sends only after Send', async () => {
    await enable();
    await commentOn('worth a comment', 'What do you think, @claude?');
    expect(q('.tg-ai-title')?.textContent).toBe('Ask AI');
    expandAll();
    expect([...panelEl().querySelectorAll('.tg-ai-items li')].map((li) => li.textContent)).toEqual([
      'The passage (15 characters)',
      '1 message in this thread',
      `The text before the first heading (${NOTE_TEXT.trimEnd().length} characters)`,
    ]);
    expect(requests).toHaveLength(0);

    const radios = [...panelEl().querySelectorAll<HTMLInputElement>('.tg-ai-scope input')];
    radios[2].dispatchEvent(new Event('change'));
    await flush();
    button('Send')!.click();
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      noteName: '2026-09-28',
      quote: 'worth a comment',
      image: null,
      context: { label: 'The whole note', text: NOTE_TEXT.trimEnd() },
      messages: [{ author: 'Me', origin: 'human', body: 'What do you think, @claude?' }],
    });
    expect(threads()[0].messages).toHaveLength(2);
    expect(button('Add to thread')).toBeUndefined();
    expect(threads()[0].messages[1]).toMatchObject({ author: { kind: 'ai', name: 'Claude' }, origin: 'ai', body: 'A synthetic reply.' });
    expect(q('.tg-ai')).toBeNull();
    expect(panelEl().querySelector('.tg-origin')?.textContent).toBe('AI');
  });

  it('sends nothing the preview did not show: a note edited after the preview sends the preview back', async () => {
    await enable();
    await commentOn('worth a comment', 'Thoughts, @claude?');
    expect(q('.tg-ai-title')?.textContent).toBe('Ask AI');
    // The note changes after the preview was drawn, before Send (no refresh in between).
    app.vault.adapter.files.set(NOTE, NOTE_TEXT.replace('A sentence', 'A secret sentence'));
    button('Send')!.click();
    await flush();
    expect(requests).toHaveLength(0);
    expect(q('.tg-ai-title')?.textContent).toBe('Ask AI');
    expect(q('.tg-ai-error')?.textContent).toBe('The note changed since this preview. Check it and send again.');
    expandAll();
    expect(q('.tg-ai-exact pre')?.textContent).toContain('A secret sentence');

    // The question is still the preview's own: Escape there would remove it, as before Send.
    expect((plugin as unknown as { aiQuestions: Map<string, string> }).aiQuestions.has(threads()[0].id)).toBe(true);

    // The refreshed preview is what goes, and checking it again used no retry.
    button('Send')!.click();
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0].context?.text).toContain('A secret sentence');
    expect((plugin as unknown as { aiQuestions: Map<string, string> }).aiQuestions.has(threads()[0].id)).toBe(false);
  });

  it('Escape on a preview that came back from a stale Send still removes the question', async () => {
    await enable();
    await commentOn('worth a comment', 'Thoughts, @claude?');
    app.vault.adapter.files.set(NOTE, NOTE_TEXT.replace('A sentence', 'A changed sentence'));
    button('Send')!.click();
    await flush();
    expect(requests).toHaveLength(0);
    const id = threads()[0].id;
    panelActions().aiClose(id, true);
    await flush();
    expect(threads()[0].messages.every((m) => m.deletedAt)).toBe(true);
  });

  it('sends nothing when Send is pressed before any preview was shown', async () => {
    await enable();
    await commentOn('worth a comment', 'Plain comment');
    const id = threads()[0].id;
    const actions = panelActions();
    actions.aiOpen(id);
    actions.aiSend(id);
    await flush();
    expect(requests).toHaveLength(0);
    expect(q('.tg-ai-error')?.textContent).toBe('The note changed since this preview. Check it and send again.');
  });

  it('retains a failed auto-save, allows editing and saves recovery with AI-edited attribution', async () => {
    await enable();
    await commentOn('worth a comment', 'First');
    const reply = q<HTMLTextAreaElement>('textarea[data-draft-key^="reply:"]')!;
    reply.value = '@Claude please weigh in';
    reply.dispatchEvent(new Event('input'));
    button('Reply')!.click();
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(app.vault.adapter, 'write').mockRejectedValue(new Error('disk full'));
    button('Send')!.click();
    await flush();
    const draft = q<HTMLTextAreaElement>('.tg-ai textarea')!;
    draft.value = 'A synthetic reply, edited by me.';
    draft.dispatchEvent(new Event('input'));
    write.mockRestore();
    button('Add to thread')!.click();
    await flush();
    expect(threads()[0].messages.at(-1)).toMatchObject({ origin: 'ai-edited', author: { kind: 'ai' } });
    expect([...panelEl().querySelectorAll('.tg-origin')].at(-1)?.textContent).toBe('AI · edited by you');
  });

  it('shows provider errors and retries without duplicating replies', async () => {
    await enable();
    await commentOn('worth a comment', 'Try');
    button('Ask AI')!.click();
    await flush();
    answers.push({ ok: false, kind: 'quota', message: 'Claude is at a usage or rate limit.' });
    button('Send')!.click();
    await flush();
    expect(panelEl().querySelector('.tg-ai-error')?.textContent).toBe('Claude is at a usage or rate limit.');
    button('Retry')!.click();
    await flush();
    expect(requests).toHaveLength(2);
    expect(threads()[0].messages.filter((m) => m.origin === 'ai')).toHaveLength(1);
  });

  it('will not delete while an AI reply is saving, and closes an open Ask AI card on delete', async () => {
    await enable();
    await commentOn('worth a comment', 'Hmm');
    const id = threads()[0].id;
    const question = threads()[0].messages[0].id;
    const actions = panelActions();
    // Hold the reply's save open, to delete while it is in progress.
    const original = app.vault.adapter.write.bind(app.vault.adapter);
    let finish = () => {};
    const write = vi.spyOn(app.vault.adapter, 'write').mockImplementation(
      (path: string, data: string) => new Promise<void>((done) => { finish = () => void original(path, data).then(done); }),
    );
    actions.aiOpen(id);
    await flush(); // the preview is on screen before Send, as in the panel
    actions.aiSend(id);
    await flush();
    expect(await actions.setMessageDeleted(id, question, true)).toBe(false);
    expect(await actions.setThreadDeleted(id, true)).toBe(false);
    expect(notices.at(-1)).toBe('The AI reply is saving. Try deleting again in a moment.');
    write.mockRestore();
    finish();
    await flush();
    expect(threads()[0].messages.map((m) => [m.origin, !!m.deletedAt])).toEqual([['human', false], ['ai', false]]);

    actions.aiOpen(id);
    await flush();
    expect(q('.tg-ai')).not.toBeNull();
    expect(await actions.setThreadDeleted(id, true)).toBe(true);
    expect(q('.tg-ai')).toBeNull();
  });

  it('cancel and close leave the thread untouched', async () => {
    await enable();
    await commentOn('worth a comment', 'Hmm');
    button('Ask AI')!.click();
    await flush();
    button('Cancel')!.click();
    await flush();
    expect(q('.tg-ai')).toBeNull();
    const actions = (plugin as unknown as { panelActions(): { aiCancel(id: string): void; aiAdopt(id: string, b: string): Promise<boolean> } }).panelActions();
    actions.aiCancel(threads()[0].id);
    expect(await actions.aiAdopt(threads()[0].id, 'no draft')).toBe(false);
    expect(threads()[0].messages).toHaveLength(1);
  });

  describe('with an image thread', () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const TRIP = 'Trip.md';
    const TRIP_TEXT = 'Look:\n![[sky.png]]\n';

    async function imageThread() {
      app.vault.adapter.files.set(TRIP, TRIP_TEXT);
      app.vault.adapter.files.set('Pics/sky.png', 'placeholder');
      app.vault.binaries.set('Pics/sky.png', PNG);
      const trip = app.workspace.open(TRIP) as typeof view;
      const at = TRIP_TEXT.indexOf('![[sky.png]]') + 3;
      trip.editor.selection = [at, at];
      await enable();
      command('comment-on-selection').editorCheckCallback!(false, trip.editor, trip);
      await flush();
      const input = q<HTMLTextAreaElement>('.tg-card-new textarea')!;
      input.value = 'What is in this picture, @Claude?';
      input.dispatchEvent(new Event('input'));
      button('Comment')!.click();
      await flush();
    }

    it('sends the image file’s real bytes, not a caption', async () => {
      await imageThread();
      expandAll();
      expect(panelEl().querySelector('.tg-ai-items li')?.textContent).toBe('The image sky.png');
      button('Send')!.click();
      await flush();
      expect(requests[0].quote).toBeNull();
      expect(requests[0].image).toEqual({
        path: 'Pics/sky.png',
        mediaType: 'image/png',
        data: Buffer.from(PNG).toString('base64'),
        bytes: PNG.length,
      });
    });

    it('does not send an image replaced after the preview', async () => {
      await imageThread();
      app.vault.stats.set('Pics/sky.png', { ctime: 0, mtime: 1_700_000_000_000, size: PNG.length });
      button('Send')!.click();
      await flush();
      expect(requests).toHaveLength(0);
      expect(panelEl().querySelector('.tg-ai-error')?.textContent).toBe('The note changed since this preview. Check it and send again.');
      button('Send')!.click();
      await flush();
      expect(requests).toHaveLength(1);
    });

    it('refuses a damaged or missing image before calling the model', async () => {
      await imageThread();
      app.vault.binaries.set('Pics/sky.png', new TextEncoder().encode('not an image'));
      button('Send')!.click();
      await flush();
      expect(panelEl().querySelector('.tg-ai-error')?.textContent).toBe('Pics/sky.png does not contain valid PNG, JPEG or WebP data.');
      app.vault.adapter.files.delete('Pics/sky.png');
      button('Retry')!.click();
      await flush();
      expect(panelEl().querySelector('.tg-ai-error')?.textContent).toBe('Image file not found: Pics/sky.png');
      expect(requests).toHaveLength(0);
    });
  });

  it('reports a thread whose note disappeared', async () => {
    await enable();
    await commentOn('worth a comment', 'Gone soon');
    button('Ask AI')!.click();
    await flush();
    app.vault.adapter.files.delete(NOTE);
    const actions = (plugin as unknown as { panelActions(): { aiSend(id: string): void } }).panelActions();
    actions.aiSend(threads()[0].id);
    await flush();
    expect(requests).toHaveLength(0);
  });

  it('shows the new answer after Retry, not an edit of the old one (Gitar review on PR #5)', async () => {
    await enable();
    await commentOn('worth a comment', 'Question');
    button('Ask AI')!.click();
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(app.vault.adapter, 'write').mockRejectedValue(new Error('disk full'));
    answers.push({ ok: true, text: 'First answer.' }, { ok: true, text: 'Second answer.' });
    button('Send')!.click();
    await flush();
    const draft = q<HTMLTextAreaElement>('.tg-ai textarea')!;
    draft.value = 'First answer, edited.';
    draft.dispatchEvent(new Event('input'));
    button('Retry')!.click();
    await flush();
    expect(q<HTMLTextAreaElement>('.tg-ai textarea')!.value).toBe('Second answer.');
    write.mockRestore();
    button('Add to thread')!.click();
    await flush();
    expect(threads()[0].messages.at(-1)).toMatchObject({ body: 'Second answer.', origin: 'ai' });

    // An edited draft closed from an error does not leak into the next session.
    button('Ask AI')!.click();
    await flush();
    const secondWrite = vi.spyOn(app.vault.adapter, 'write').mockRejectedValue(new Error('disk full'));
    answers.push({ ok: true, text: 'Third answer.' }, { ok: false, kind: 'network', message: 'offline' });
    button('Send')!.click();
    await flush();
    const third = q<HTMLTextAreaElement>('.tg-ai textarea')!;
    third.value = 'Stale edit';
    third.dispatchEvent(new Event('input'));
    button('Retry')!.click();
    await flush();
    button('Close')!.click();
    await flush();
    button('Ask AI')!.click();
    await flush();
    secondWrite.mockRestore();
    answers.push({ ok: true, text: 'Fresh answer.' });
    button('Send')!.click();
    await flush();
    expect(threads()[0].messages.at(-1)?.body).toBe('Fresh answer.');
    expect(requests).toHaveLength(5);
  });

  it('removes AI cards and stops requests when AI is switched off, and shows Ask at once when on (Gitar review on PR #5)', async () => {
    let finish!: (r: AiResult) => void;
    let seen: AbortSignal | undefined;
    plugin.adapterFactory = (settings) =>
      settings.aiEnabled
        ? [
            {
              id: 'claude',
              name: 'Claude',
              detail: 'slow',
              egress: 'cloud',
              capabilities: { text: true, images: true },
              ask: (_req: AiRequest, signal: AbortSignal) => {
                seen = signal;
                return new Promise<AiResult>((r) => (finish = r));
              },
            },
          ]
        : [];
    await commentOn('worth a comment', 'Toggle me');
    const tab = (plugin as unknown as { settingTabs: { display(): void; containerEl: HTMLElement }[] }).settingTabs[0];
    tab.display();
    const toggle = tab.containerEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await flush();
    expect(button('Ask AI')).toBeDefined();

    button('Ask AI')!.click();
    await flush();
    button('Send')!.click();
    await flush();
    expect(q('.tg-ai-title')?.textContent).toBe('Asking Claude…');

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await flush();
    expect(seen?.aborted).toBe(true);
    expect(q('.tg-ai')).toBeNull();
    expect(button('Ask AI')).toBeUndefined();
    finish({ ok: true, text: 'Too late' });
    await flush();
    expect(q('.tg-ai')).toBeNull();
    expect(threads()[0].messages).toHaveLength(1);
  });

  it('builds the adapter once per settings change, not on every refresh (Gitar review on PR #5)', async () => {
    const factory = vi.fn(plugin.adapterFactory);
    plugin.adapterFactory = factory;
    await enable();
    await commentOn('worth a comment', 'Count');
    await plugin.refresh();
    await plugin.refresh();
    expect(factory).toHaveBeenCalledTimes(1);
    plugin.settings.claudeModel = 'sonnet';
    await plugin.refresh();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('saves the AI settings, Local first', async () => {
    const tab = (plugin as unknown as { settingTabs: { display(): void; containerEl: HTMLElement }[] }).settingTabs[0];
    tab.display();
    const names = [...tab.containerEl.querySelectorAll('.setting-name')].map((n) => n.textContent);
    expect(names.indexOf('Local (Ollama on this computer)')).toBeLessThan(names.indexOf('Gemini (Gemini CLI, sent to Google)'));
    expect(names.indexOf('Gemini (Gemini CLI, sent to Google)')).toBeLessThan(names.indexOf('Claude (Claude Code, sent to Anthropic)'));
    const [enabled, , gemini] = [...tab.containerEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const [, host, localModel, geminiPath, geminiModel, geminiFolder, claudePath, claudeModel, timeout] = [
      ...tab.containerEl.querySelectorAll<HTMLInputElement>('input:not([type])'),
    ];
    const preferred = tab.containerEl.querySelector('select')!;
    expect(preferred.value).toBe('local');
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change'));
    gemini.checked = false;
    gemini.dispatchEvent(new Event('change'));
    preferred.value = 'claude';
    preferred.dispatchEvent(new Event('change'));
    for (const [input, value] of [
      [host, ' http://box:11434 '],
      [localModel, 'qwen3:14b'],
      [geminiPath, '/opt/gemini'],
      [geminiModel, 'gemini-3.1-flash-lite'],
      [geminiFolder, '~/.gem'],
      [claudePath, ' /opt/claude '],
      [claudeModel, ' sonnet '],
      [timeout, '45'],
    ] as const) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    await flush();
    expect(plugin.settings).toMatchObject({
      aiEnabled: true,
      assistants: { local: true, gemini: false, claude: true },
      defaultAssistant: 'claude',
      ollamaHost: 'http://box:11434',
      ollamaModel: 'qwen3:14b',
      geminiPath: '/opt/gemini',
      geminiModel: 'gemini-3.1-flash-lite',
      geminiFolder: '~/.gem',
      claudePath: '/opt/claude',
      claudeModel: 'sonnet',
      aiTimeoutSeconds: 45,
    });
    for (const input of [timeout, host, localModel, geminiModel]) {
      input.value = input === timeout ? '3' : ' ';
      input.dispatchEvent(new Event('input'));
    }
    await flush();
    expect(plugin.settings).toMatchObject({
      aiTimeoutSeconds: DEFAULT_AI_SETTINGS.aiTimeoutSeconds,
      ollamaHost: DEFAULT_AI_SETTINGS.ollamaHost,
      ollamaModel: DEFAULT_AI_SETTINGS.ollamaModel,
      geminiModel: DEFAULT_AI_SETTINGS.geminiModel,
    });
  });

  it('loads settings saved before there were several assistants', async () => {
    (plugin as unknown as { data: unknown }).data = { authorName: 'Jonah', aiEnabled: true, aiModel: 'opus', claudePath: '/c' };
    await plugin.loadSettings();
    expect(plugin.settings).toMatchObject({ authorName: 'Jonah', aiEnabled: true, claudeModel: 'opus', claudePath: '/c', defaultAssistant: 'local' });
    (plugin as unknown as { data: unknown }).data = null;
    await plugin.loadSettings();
    expect(plugin.settings.authorName).toBe('Me');
  });
});

describe('Threadglyph plugin with several assistants', () => {
  const asked: string[] = [];
  const fake = (id: string, name: string, egress: 'local' | 'cloud'): AiAdapter => ({
    id,
    name,
    detail: `${id}-model`,
    egress,
    capabilities: { text: true, images: true },
    ask: async () => {
      asked.push(id);
      return { ok: true, text: `Reply from ${name}.` };
    },
  });

  beforeEach(async () => {
    asked.length = 0;
    plugin.adapterFactory = (settings) =>
      settings.aiEnabled ? [fake('local', 'Local', 'local'), fake('gemini', 'Gemini', 'cloud'), fake('claude', 'Claude', 'cloud')] : [];
    plugin.settings.aiEnabled = true;
    await plugin.refresh();
  });

  it('opens Ask AI with the preferred assistant, Local by default', async () => {
    await commentOn('worth a comment', 'Plain');
    button('Ask AI')!.click();
    await flush();
    expandAll();
    expect((q<HTMLInputElement>('.tg-ai-assistant input:checked'))?.value).toBe('local');
    expect(q('.tg-ai-note')?.textContent).toBe('Local will receive the items below. Stays on this computer.');
    button('Send')!.click();
    await flush();
    expect(threads()[0].messages.at(-1)).toMatchObject({ author: { kind: 'ai', name: 'Local' }, body: 'Reply from Local.' });
    expect(asked).toEqual(['local']);
  });

  it('opens with the mentioned assistant, and can switch before sending', async () => {
    await commentOn('worth a comment', 'Over to you @Gemini');
    expandAll();
    expect(q<HTMLInputElement>('.tg-ai-assistant input:checked')?.value).toBe('gemini');
    q<HTMLInputElement>('.tg-ai-assistant input[value="claude"]')!.dispatchEvent(new Event('change'));
    await flush();
    button('Send')!.click();
    await flush();
    expect(asked).toEqual(['claude']);
    expect(threads()[0].messages.at(-1)?.author.name).toBe('Claude');
    expect(q('.tg-ai')).toBeNull();
  });

  it('uses the first mention when several assistants are named', async () => {
    await commentOn('worth a comment', '@Claude or maybe @Local?');
    expandAll();
    expect(q<HTMLInputElement>('.tg-ai-assistant input:checked')?.value).toBe('claude');
    expect(q<HTMLInputElement>('.tg-ai-assistant.is-selected input')?.value).toBe('claude');
    expect(panelEl().querySelectorAll('.tg-ai-assistant.is-selected')).toHaveLength(1);
  });

  it('honours a different preferred assistant, and falls back when it is off', async () => {
    plugin.settings.defaultAssistant = 'gemini';
    await commentOn('worth a comment', 'Plain');
    button('Ask AI')!.click();
    await flush();
    expandAll();
    expect(q<HTMLInputElement>('.tg-ai-assistant input:checked')?.value).toBe('gemini');
    plugin.adapterFactory = () => [];
    await plugin.refresh();
    const actions = (plugin as unknown as { panelActions(): { aiOpen(id: string): void; aiSend(id: string): void } }).panelActions();
    actions.aiOpen(threads()[0].id);
    actions.aiSend(threads()[0].id);
    await flush();
    expect(asked).toEqual([]);
  });

  it('keeps the author of a draft whose assistant was switched off before adding it', async () => {
    await commentOn('worth a comment', '@Gemini hi');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(app.vault.adapter, 'write').mockRejectedValue(new Error('disk full'));
    button('Send')!.click();
    await flush();
    plugin.adapterFactory = (settings) => (settings.aiEnabled ? [fake('local', 'Local', 'local')] : []);
    await plugin.refresh();
    const actions = (plugin as unknown as { panelActions(): { aiAdopt(id: string, body: string): Promise<boolean> } }).panelActions();
    write.mockRestore();
    expect(await actions.aiAdopt(threads()[0].id, 'Reply from Gemini.')).toBe(true);
    expect(threads()[0].messages.at(-1)?.author).toEqual({ kind: 'ai', name: 'gemini' });
  });

  it('posts with Cmd+Enter, sends with Enter from the preview, and automatically appends one reply', async () => {
    await commentOn('worth a comment', 'Start');
    const input = q<HTMLTextAreaElement>('textarea[data-draft-key^="reply:"]')!;
    input.focus();
    input.value = 'Explain this @Local';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input'));
    const enter = (metaKey = false) => new KeyboardEvent('keydown', { key: 'Enter', metaKey, bubbles: true, cancelable: true });
    // Enter is a new line in a comment box, even with an @mention; Cmd+Enter posts.
    input.dispatchEvent(enter());
    await flush();
    expect(q('.tg-ai')).toBeNull();
    input.dispatchEvent(enter(true));
    await flush();
    expect(asked).toEqual([]);
    const first = document.activeElement as HTMLElement;
    expect(first.textContent).toContain('What to send');
    expandAll();
    expect(q<HTMLInputElement>('.tg-ai-scope input:checked')?.value).toBe('section');
    expect(q('.tg-ai-exact pre')).not.toBeNull();
    const send = button('Send')!;
    send.focus();
    send.dispatchEvent(enter());
    send.dispatchEvent(enter());
    await flush();
    expect(asked).toEqual(['local']);
    expect(threads()[0].messages).toHaveLength(3);
    expect(threads()[0].messages.at(-1)?.origin).toBe('ai');
    expect(q('.tg-ai')).toBeNull();
  });

  it('Escape cancels the whole request, discarding the question (restorable)', async () => {
    await commentOn('worth a comment', '@Local explain');
    const send = button('Send')!;
    send.focus();
    send.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    expect(q('.tg-ai')).toBeNull();
    expect(asked).toEqual([]);
    expect(threads()[0].messages[0]).toMatchObject({ body: '@Local explain', deletedAt: expect.any(String) });
    expect(q('.tg-card[data-thread-id]')).toBeNull();
  });

  it('Escape discards only an unsent question: a reply that asked, not the thread before it', async () => {
    await commentOn('worth a comment', 'Plain start');
    const input = q<HTMLTextAreaElement>('textarea[data-draft-key^="reply:"]')!;
    input.value = '@Local what now?';
    input.dispatchEvent(new Event('input'));
    button('Reply')!.click();
    await flush();
    const row = q<HTMLElement>('.tg-ai-group')!;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    expect(threads()[0].messages.map((m) => [m.body, !!m.deletedAt])).toEqual([['Plain start', false], ['@Local what now?', true]]);

    // After Send, the question belongs to the thread: closing never removes it.
    button('Ask AI')!.click();
    await flush();
    button('Send')!.click();
    await flush();
    expect(threads()[0].messages.filter((m) => !m.deletedAt)).toHaveLength(2);
  });

  it('describes where each assistant sends requests', () => {
    expect(destination(fake('local', 'Local', 'local'))).toBe('Stays on this computer');
    expect(destination(fake('local', 'Local', 'cloud'))).toBe('Sent to ollama.com');
    expect(destination(fake('gemini', 'Gemini', 'cloud'))).toBe('Sent to Google');
    expect(destination(fake('claude', 'Claude', 'cloud'))).toBe('Sent to Anthropic');
    expect(destination(fake('other', 'Other', 'cloud'))).toBe('Sent to the provider');
    expect(destination({ ...fake('local', 'Local', 'cloud'), recipient: 'gpu-box.lan' })).toBe('Sent to gpu-box.lan');
  });
});

describe('Threadglyph plugin commands for search, import and backup', () => {
  const LEGACY = 'Garden.md';
  const LEGACY_TEXT =
    'Plan: {==plant early==}{>>user|2026-09-16 14:20|question: Too soon?<<}{>>Local|2026-09-16 14:21|reply: Wait for May.<<}\n' +
    'Done: {==weed==}{>>user|2026-09-17|note: ok<<}{>>user|2026-09-17|resolve: <<}\n';

  it('focuses the thread search from the command palette', async () => {
    await command('search-threads').callback!();
    await flush();
    expect(document.activeElement).toBe(q('.tg-search'));
  });

  it('previews an inline comment import, imports on confirm, and never edits the note', async () => {
    app.vault.adapter.files.set(LEGACY, LEGACY_TEXT);
    const garden = app.workspace.open(LEGACY) as typeof view;
    const cmd = command('import-inline-comments');
    expect(cmd.editorCheckCallback!(true, view.editor, view)).toBe(false);
    expect(cmd.editorCheckCallback!(true, garden.editor, { file: null })).toBe(false);
    expect(cmd.editorCheckCallback!(true, garden.editor, garden)).toBe(true);
    cmd.editorCheckCallback!(false, garden.editor, garden);
    const modal = openModals.at(-1)!;
    expect(modal.titleEl.textContent).toBe('Import inline comments');
    expect([...modal.contentEl.querySelectorAll('.tg-import-meta')].map((e) => e.textContent)).toEqual([
      '2 messages · Will be imported',
      '1 message · resolved · Will be imported',
    ]);
    expect(threads()).toHaveLength(0);
    const importButton = [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Import 2')!;
    importButton.click();
    await flush();
    expect(openModals).not.toContain(modal);
    expect(threads().map((t) => [t.status, t.messages.map((m) => m.author.name)])).toEqual([
      ['open', ['Me', 'Local']],
      ['resolved', ['Me']],
    ]);
    expect(app.vault.adapter.files.get(LEGACY)).toBe(LEGACY_TEXT);
    expect(notices.at(-1)).toBe('Threadglyph imported 2 thread(s). The note was not changed.');

    // A second preview recognises both as imported, and Cancel closes without writing.
    cmd.editorCheckCallback!(false, garden.editor, garden);
    const again = openModals.at(-1)!;
    const run = [...again.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Nothing new to import')!;
    expect(run.disabled).toBe(true);
    [...again.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
    expect(threads()).toHaveLength(2);
  });

  it('backs up to the local-only folder and restores only missing threads', async () => {
    await commentOn('worth a comment', 'Back me up');
    const path = await plugin.backUp();
    expect(path.startsWith('.threadglyph/exports/')).toBe(true);
    expect(JSON.parse(app.vault.adapter.files.get(path)!).threads).toHaveLength(1);

    await command('restore-threads').callback!();
    const modal = openModals.at(-1)!;
    const pick = modal.contentEl.querySelector<HTMLButtonElement>('.tg-restore-file')!;
    pick.click();
    await flush();
    expect(notices.at(-1)).toBe('Threadglyph restored 0 thread(s); 1 already existed.');

    const id = threads()[0].id;
    app.vault.adapter.files.delete(`${THREADS_DIR}/${id}.json`);
    await (plugin as unknown as { store: { loadAll(): Promise<void> } }).store.loadAll();
    await plugin.restore(path);
    expect(notices.at(-1)).toBe('Threadglyph restored 1 thread(s); 0 already existed.');
    expect(threads()[0].messages[0].body).toBe('Back me up');

    app.vault.adapter.files.set('.threadglyph/exports/broken.json', '{"format":"other"}');
    await plugin.restore('.threadglyph/exports/broken.json');
    expect(notices.at(-1)).toMatch(/could not restore .*not a Threadglyph backup\. Nothing was changed\./);
    await plugin.restore('.threadglyph/exports/missing.json');
    expect(notices.at(-1)).toMatch(/file not found/);
  });

  it('reports invalid records skipped during a restore', async () => {
    app.vault.adapter.files.set('.threadglyph/exports/partial.json', JSON.stringify({ format: 'threadglyph-export', version: 1, threads: [{}], anchors: [] }));
    await plugin.restore('.threadglyph/exports/partial.json');
    expect(notices.at(-1)).toBe('Threadglyph restored 0 thread(s); 0 already existed, 1 invalid record(s) skipped.');
  });

  it('explains when there is no backup to restore', async () => {
    await command('restore-threads').callback!();
    expect(openModals.at(-1)!.contentEl.textContent).toMatch(/No backups yet/);
    openModals.at(-1)!.close();
  });
});

describe('Threadglyph plugin threads on missing notes', () => {
  const anchorOf = (id: string) => JSON.parse(app.vault.adapter.files.get(`${ANCHORS_DIR}/${id}.json`)!);
  const buttonIn = (modal: { contentEl: HTMLElement }, text: string) =>
    [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === text)!;

  it('lists threads whose note is gone and moves one into the open note, anchor and all', async () => {
    await commentOn('worth a comment', 'Keep me');
    const id = threads()[0].id;
    const reply = q<HTMLTextAreaElement>('.tg-card-focused textarea')!;
    reply.value = 'And me';
    reply.dispatchEvent(new Event('input'));
    button('Reply')!.click();
    await flush();
    app.vault.adapter.files.delete(NOTE);
    app.vault.adapter.files.set('Renamed.md', NOTE_TEXT);
    app.workspace.open('Renamed.md');
    await plugin.refresh();

    command('threads-on-missing-notes').callback!();
    const modal = openModals.at(-1)!;
    expect(modal.titleEl.textContent).toBe('Threads on missing notes');
    expect(modal.contentEl.querySelector('.tg-missing-path')!.textContent).toBe(NOTE);
    expect(modal.contentEl.querySelector('.tg-quote')!.textContent).toBe('Keep me');
    expect(modal.contentEl.querySelector('.tg-import-meta')!.textContent).toMatch(/^2 comments · last activity /);

    buttonIn(modal, 'Move to “Renamed”').click();
    await flush();
    expect(threads()[0].notePath).toBe('Renamed.md');
    expect(anchorOf(id).notePath).toBe('Renamed.md');
    // The note has the same text, so the passage is found there and the card is focused.
    expect(q('.tg-card-focused .tg-message-body')?.textContent).toBe('Keep me');
    expect(threads()[0].messages).toHaveLength(2);
    expect(q('.tg-card-focused .tg-anchor-problem')).toBeNull();
    expect(modal.contentEl.textContent).toBe('Every thread’s note is in the vault.');
    modal.close();
  });

  it('deletes a thread on a missing note and restores it from the same list', async () => {
    await commentOn('worth a comment', 'Delete me');
    app.vault.adapter.files.delete(NOTE);
    command('threads-on-missing-notes').callback!();
    const modal = openModals.at(-1)!;
    buttonIn(modal, 'Delete').click();
    await flush();
    expect(threads()[0].messages.every((m) => m.deletedAt)).toBe(true);
    expect(modal.contentEl.querySelector('.tg-missing-deleted .tg-import-meta')!.textContent).toBe('Deleted');
    buttonIn(modal, 'Restore').click();
    await flush();
    expect(threads()[0].messages.some((m) => m.deletedAt)).toBe(false);
    modal.close();
  });

  it('previews the comments Restore brings back, not one deleted earlier on its own (Gitar on #46)', async () => {
    await commentOn('worth a comment', 'First, deleted alone');
    const reply = q<HTMLTextAreaElement>('.tg-card-focused textarea')!;
    reply.value = 'Second';
    reply.dispatchEvent(new Event('input'));
    button('Reply')!.click();
    await flush();
    const [t] = threads();
    const actions = panelActions();
    await actions.setMessageDeleted(t.id, t.messages[0].id, true);
    await actions.setThreadDeleted(t.id, true);
    app.vault.adapter.files.delete(NOTE);
    command('threads-on-missing-notes').callback!();
    const modal = openModals.at(-1)!;
    expect(modal.contentEl.querySelector('.tg-quote')!.textContent).toBe('Second');
    modal.close();
  });

  it('cannot move without an open note, and says when nothing is missing', async () => {
    command('threads-on-missing-notes').callback!();
    expect(openModals.at(-1)!.contentEl.textContent).toBe('Every thread’s note is in the vault.');
    openModals.at(-1)!.close();

    await commentOn('worth a comment', 'Orphan');
    app.vault.adapter.files.delete(NOTE);
    command('threads-on-missing-notes').callback!();
    const modal = openModals.at(-1)!;
    expect(modal.contentEl.textContent).toMatch(/Open a note first/);
    const move = buttonIn(modal, 'Move to the open note');
    expect(move.disabled).toBe(true);
    // A failed move (for example the thread changed elsewhere) leaves it listed.
    const actions = (modal as unknown as { actions: { move(id: string): Promise<boolean> } }).actions;
    expect(await actions.move(threads()[0].id)).toBe(false);
    modal.close();
  });

  it('reports a refused move and keeps the thread listed', async () => {
    await commentOn('worth a comment', 'Stays');
    app.vault.adapter.files.delete(NOTE);
    app.vault.adapter.files.set('Other.md', 'Unrelated note.\n');
    app.workspace.open('Other.md');
    await plugin.refresh();
    // Another device bumped the thread on disk, so the move conflicts.
    const [t] = threads();
    app.vault.adapter.files.set(`${THREADS_DIR}/${t.id}.json`, JSON.stringify({ ...t, revision: t.revision + 5 }));
    command('threads-on-missing-notes').callback!();
    const modal = openModals.at(-1)!;
    buttonIn(modal, 'Move to “Other”').click();
    await flush();
    expect(notices.at(-1)).toMatch(/changed elsewhere/);
    expect(modal.contentEl.querySelector('.tg-missing-path')!.textContent).toBe(NOTE);
    modal.close();
  });

  it('waits until threads have loaded', async () => {
    (plugin as unknown as { loaded: boolean }).loaded = false;
    command('threads-on-missing-notes').callback!();
    expect(notices.at(-1)).toMatch(/still loading/);
  });
});

describe('Threadglyph plugin image titles', () => {
  const TRIP = 'Trip.md';
  const TRIP_TEXT = 'Look:\n![[sky.png|Evening sky]]\n';

  it('starts an image thread from the Comment button on an image title in the editor', async () => {
    app.vault.adapter.files.set(TRIP, TRIP_TEXT);
    app.vault.adapter.files.set('Pics/sky.png', 'placeholder');
    const trip = app.workspace.open(TRIP) as typeof view;
    trip.editor.cm = new EditorView({
      state: EditorState.create({ doc: TRIP_TEXT, extensions: (plugin as unknown as { extensions: Extension[] }).extensions }),
      parent: document.body,
    });
    trip.editor.cm.dom.querySelector<HTMLButtonElement>('.tg-image-comment')!.click();
    await flush();
    expect(q('.tg-card-new .tg-image-name')?.textContent).toBe('sky.png');
    trip.editor.cm.destroy();
  });

  it('starts an image thread from a Reading view title, and explains a missing file', async () => {
    app.vault.adapter.files.set(TRIP, TRIP_TEXT);
    app.workspace.open(TRIP);
    const processor = (plugin as unknown as { postProcessors: ((el: HTMLElement, ctx: unknown) => void)[] }).postProcessors[0];
    const el = document.createElement('div');
    el.innerHTML = '<p><span class="internal-embed image-embed" src="sky.png|Evening sky"></span></p>';
    processor(el, { sourcePath: TRIP, getSectionInfo: () => ({ text: TRIP_TEXT, lineStart: 1, lineEnd: 1 }) });
    el.querySelector<HTMLButtonElement>('.tg-image-comment')!.click();
    await flush();
    expect(notices.at(-1)).toBe('Image file not found in this vault: sky.png');
    app.vault.adapter.files.set('Pics/sky.png', 'placeholder');
    el.querySelector<HTMLButtonElement>('.tg-image-comment')!.click();
    await flush();
    expect(q('.tg-card-new .tg-image-name')?.textContent).toBe('sky.png');

    // A section whose note is gone does nothing.
    const orphan = document.createElement('div');
    orphan.innerHTML = el.innerHTML.replace(/<button[\s\S]*$/, '');
    orphan.querySelector('.tg-image-title')?.remove();
    processor(orphan, { sourcePath: 'Gone.md', getSectionInfo: () => ({ text: TRIP_TEXT, lineStart: 1, lineEnd: 1 }) });
    orphan.querySelector<HTMLButtonElement>('.tg-image-comment')!.click();
    await flush();
  });

  it('ignores a Comment click from an editor that belongs to no open note', async () => {
    const stray = new EditorView({
      state: EditorState.create({ doc: '![[a.png]]', extensions: (plugin as unknown as { extensions: Extension[] }).extensions }),
      parent: document.body,
    });
    stray.dom.querySelector<HTMLButtonElement>('.tg-image-comment')!.click();
    await flush();
    expect(q('.tg-card-new')).toBeNull();
    stray.destroy();
  });
});
