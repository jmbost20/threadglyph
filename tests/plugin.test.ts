// @vitest-environment happy-dom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
// Same module the 'obsidian' alias resolves to for src/main.ts.
import { FakeApp, TFile, notices, type MarkdownView } from './obsidianStub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadglyphPlugin from '../src/main';
import { addReply } from '../src/model/thread';
import type { ThreadRecord } from '../src/model/types';
import { ANCHORS_DIR, THREADS_DIR } from '../src/storage/paths';

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
const button = (label: string) =>
  [...panelEl().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const command = (id: string) => (plugin as unknown as { commands: { id: string; editorCheckCallback?: (...a: unknown[]) => boolean; callback?: () => void }[] }).commands.find((c) => c.id === id)!;
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
    const before = new Map(app.vault.adapter.files);
    app.vault.trigger('rename', new TFile(`${THREADS_DIR}/x-renamed-1.json`), `${THREADS_DIR}/x-original-1.json`);
    await flush();
    expect(app.vault.adapter.files).toEqual(before);
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
    (panelEl().querySelector('.tg-icon-button') as HTMLButtonElement).click();
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

  it('handles panel actions: cancel, edit and cancel edit, resolve toggle, reopen', async () => {
    select('Evening');
    command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
    await flush();
    button('Cancel')!.click();
    await flush();
    expect(q('.tg-card-new')).toBeNull();

    await commentOn('worth a comment', 'Edit me');
    (panelEl().querySelector('.tg-icon-button') as HTMLButtonElement).click();
    await flush();
    button('Cancel')!.click();
    await flush();
    expect(q('.tg-card textarea[data-draft-key^="edit:"]')).toBeNull();

    (panelEl().querySelector('.tg-icon-button') as HTMLButtonElement).click();
    await flush();
    const input = q<HTMLTextAreaElement>('textarea[data-draft-key^="edit:"]')!;
    input.value = 'Edited';
    input.dispatchEvent(new Event('input'));
    button('Save')!.click();
    await flush();
    expect(threads()[0].messages[0].body).toBe('Edited');

    button('Resolve')!.click();
    await flush();
    button('Show resolved (1)')!.click();
    await flush();
    button('Reopen')!.click();
    await flush();
    expect(threads()[0].status).toBe('open');
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
    expect((plugin as unknown as { data: unknown }).data).toEqual({ authorName: 'Jonah' });
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
