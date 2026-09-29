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
