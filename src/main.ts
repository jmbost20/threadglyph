import type { EditorView } from '@codemirror/view';
import {
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  debounce,
  type App,
  type DataAdapter,
  type Editor,
} from 'obsidian';
import { ThreadController, type Outcome } from './controller';
import { THREADS_DIR } from './storage/paths';
import { ThreadStore, type FileStore } from './storage/threadStore';
import { ThreadPanel, VIEW_TYPE_THREADGLYPH, type PanelActions } from './ui/ThreadPanel';
import { setThreadMarks, threadMarksExtension, type ThreadMark } from './ui/editorMarks';
import { buildThreadViews } from './ui/viewModel';

interface ThreadglyphSettings {
  authorName: string;
}

const DEFAULT_SETTINGS: ThreadglyphSettings = { authorName: 'Me' };

class AdapterFileStore implements FileStore {
  constructor(private readonly adapter: DataAdapter) {}

  async read(path: string): Promise<string | null> {
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
  }

  write(path: string, data: string): Promise<void> {
    return this.adapter.write(path, data);
  }

  async list(dir: string): Promise<string[]> {
    return (await this.adapter.exists(dir)) ? (await this.adapter.list(dir)).files : [];
  }

  async ensureDir(dir: string): Promise<void> {
    let path = '';
    for (const part of dir.split('/')) {
      path = path ? `${path}/${part}` : part;
      if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    }
  }
}

function cmView(view: MarkdownView): EditorView | null {
  return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
}

export default class ThreadglyphPlugin extends Plugin {
  settings: ThreadglyphSettings = DEFAULT_SETTINGS;
  private store!: ThreadStore;
  private controller!: ThreadController;
  private loaded = false;
  private showResolved = false;
  private focusedThreadId: string | null = null;
  /** The note the panel is showing; kept when focus moves into the panel itself. */
  private currentFile: TFile | null = null;

  private readonly scheduleRefresh = debounce(() => void this.refresh(), 300, true);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new ThreadStore(new AdapterFileStore(this.app.vault.adapter));
    this.controller = new ThreadController(this.store, () => ({ kind: 'human', name: this.settings.authorName }));

    this.registerView(VIEW_TYPE_THREADGLYPH, (leaf) => new ThreadPanel(leaf, this.panelActions()));
    this.registerEditorExtension(threadMarksExtension((id) => void this.focusThread(id)));

    this.addCommand({
      id: 'comment-on-selection',
      name: 'Comment on selection',
      editorCheckCallback: (checking, editor, ctx) => {
        if (!editor.somethingSelected() || !ctx.file) return false;
        if (!checking) void this.beginThread(editor, ctx.file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-panel',
      name: 'Open thread panel',
      callback: () => void this.activatePanel(),
    });
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const file = info.file;
        if (!editor.somethingSelected() || !file) return;
        menu.addItem((item) =>
          item
            .setTitle('Threadglyph: comment on selection')
            .setIcon('message-square-plus')
            .setSection('selection')
            .onClick(() => void this.beginThread(editor, file)),
        );
      }),
    );
    this.addRibbonIcon('message-square-text', 'Open Threadglyph', () => void this.activatePanel());
    this.addSettingTab(new ThreadglyphSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => void this.start());
  }

  onunload(): void {
    this.scheduleRefresh.cancel();
  }

  private async start(): Promise<void> {
    await this.store.loadAll();
    this.loaded = true;

    const isThreadFile = (file: TAbstractFile) => file.path.startsWith(`${THREADS_DIR}/`);
    const onThreadFile = async (file: TAbstractFile) => {
      await this.store.reloadThreadFile(file.path);
      this.scheduleRefresh();
    };
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (isThreadFile(file)) void onThreadFile(file);
        else if (file instanceof TFile && this.store.hasThreads(file.path)) this.scheduleRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (isThreadFile(file)) void onThreadFile(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (isThreadFile(file)) void onThreadFile(file);
        else this.scheduleRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (isThreadFile(file) || oldPath.startsWith(`${THREADS_DIR}/`)) return;
        void this.store.renameNote(oldPath, file.path).then((conflicts) => {
          if (conflicts.length) new Notice(`Threadglyph: ${conflicts.length} thread(s) changed elsewhere during the rename; reload to review.`);
          this.scheduleRefresh();
        });
      }),
    );
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleRefresh()));

    await this.refresh();
  }

  // ── Panel wiring ────────────────────────────────────────────────────────────

  private panelActions(): PanelActions {
    const c = this.controller;
    const report = (o: Outcome): boolean => {
      if (!o.ok) new Notice(o.message);
      return o.ok;
    };
    // Storage failures (disk errors) surface as a notice; the panel keeps the user's text.
    const attempt = async (work: () => Promise<Outcome>): Promise<boolean> => {
      try {
        return report(await work());
      } catch (err) {
        console.error('[threadglyph]', err);
        new Notice(`Threadglyph could not save: ${(err as Error).message}. Your text is kept.`);
        return false;
      }
    };
    return {
      drafts: c.drafts,
      editing: c.editing,
      createThread: (body) =>
        attempt(async () => {
          const result = await c.commitThread(body);
          if (result.ok && result.thread) this.focusedThreadId = result.thread.id;
          return result;
        }),
      cancelNewThread: () => {
        c.cancelThread();
        void this.refresh();
      },
      reply: (id, body) => attempt(() => c.reply(id, body)),
      startEdit: (id, messageId) => {
        c.startEdit(id, messageId);
        void this.refresh();
      },
      saveEdit: (id, messageId, body) => attempt(() => c.saveEdit(id, messageId, body)),
      cancelEdit: (id, messageId) => {
        c.cancelEdit(id, messageId);
        void this.refresh();
      },
      setResolved: async (id, resolved) => {
        await attempt(() => c.setResolved(id, resolved));
        await this.refresh();
      },
      reattach: (id) => this.reattach(id),
      goTo: (id) => this.goTo(id),
      toggleShowResolved: () => {
        this.showResolved = !this.showResolved;
        void this.refresh();
      },
      rerender: () => void this.refresh(),
    };
  }

  private panels(): ThreadPanel[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_THREADGLYPH)
      .map((leaf) => leaf.view)
      .filter((view): view is ThreadPanel => view instanceof ThreadPanel);
  }

  async activatePanel(): Promise<ThreadPanel | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_THREADGLYPH)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return null;
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_THREADGLYPH, active: true });
    await this.app.workspace.revealLeaf(leaf);
    await this.refresh();
    return leaf.view instanceof ThreadPanel ? leaf.view : null;
  }

  /** Live editor text when the note is open (including unsaved edits), else the file on disk. */
  private async noteText(file: TFile): Promise<string> {
    const view = this.markdownViewFor(file);
    return view ? view.editor.getValue() : this.app.vault.cachedRead(file);
  }

  private markdownViewFor(file: TFile): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) return leaf.view;
    }
    return null;
  }

  async refresh(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === 'md') this.currentFile = active;
    const file = this.currentFile && this.app.vault.getAbstractFileByPath(this.currentFile.path);
    const note = file instanceof TFile ? file : null;

    await this.updateEditorMarks();

    const panels = this.panels();
    if (!panels.length) return;
    const base = {
      notePath: note?.path ?? null,
      noteName: note?.basename ?? '',
      problems: this.store.loadProblems(),
      focusedThreadId: this.focusedThreadId,
      showResolved: this.showResolved,
    };
    if (!this.loaded || !note) {
      for (const panel of panels) {
        panel.update({ ...base, status: this.loaded ? 'no-note' : 'loading', views: [], pendingQuote: null });
      }
      return;
    }
    const views = buildThreadViews(this.store, note.path, await this.noteText(note));
    const pending = this.controller.pending;
    const pendingQuote = pending && pending.notePath === note.path ? pending.anchor.quote : null;
    for (const panel of panels) panel.update({ ...base, status: 'ready', views, pendingQuote });
  }

  /** Recomputes highlights and margin glyphs for every open note that has threads. */
  private async updateEditorMarks(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const cm = cmView(view);
      if (!cm) continue;
      const marks: ThreadMark[] = [];
      if (this.loaded && this.store.hasThreads(view.file.path)) {
        for (const v of buildThreadViews(this.store, view.file.path, view.editor.getValue())) {
          if (v.anchor.kind === 'found') {
            marks.push({ threadId: v.thread.id, from: v.anchor.from, to: v.anchor.to, resolved: v.thread.status === 'resolved' });
          }
        }
      }
      cm.dispatch({ effects: setThreadMarks.of(marks) });
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private async beginThread(editor: Editor, file: TFile): Promise<void> {
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    const outcome = this.controller.beginThread(file.path, editor.getValue(), from, to);
    if (!outcome.ok) {
      new Notice(outcome.message);
      return;
    }
    this.currentFile = file;
    const panel = await this.activatePanel();
    panel?.focusNewThread();
  }

  private async focusThread(threadId: string): Promise<void> {
    this.focusedThreadId = threadId;
    const thread = this.store.get(threadId);
    if (thread?.status === 'resolved') this.showResolved = true;
    const panel = await this.activatePanel();
    panel?.scrollToThread(threadId);
  }

  private async goTo(threadId: string): Promise<void> {
    const thread = this.store.get(threadId);
    if (!thread) return;
    const file = this.app.vault.getAbstractFileByPath(thread.notePath);
    if (!(file instanceof TFile)) {
      new Notice('The note for this thread is missing.');
      return;
    }
    let view = this.markdownViewFor(file);
    if (!view) {
      await this.app.workspace.getLeaf(false).openFile(file);
      view = this.markdownViewFor(file);
    }
    if (!view) return;
    const [match] = buildThreadViews(
      { forNote: () => [thread], anchorFor: (id) => this.store.anchorFor(id) },
      file.path,
      view.editor.getValue(),
    );
    if (match?.anchor.kind !== 'found') {
      new Notice('This thread’s passage could not be located.');
      return;
    }
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    const from = view.editor.offsetToPos(match.anchor.from);
    const to = view.editor.offsetToPos(match.anchor.to);
    view.editor.setSelection(from, to);
    view.editor.scrollIntoView({ from, to }, true);
    this.focusedThreadId = threadId;
  }

  private async reattach(threadId: string): Promise<void> {
    const thread = this.store.get(threadId);
    const file = thread && this.app.vault.getAbstractFileByPath(thread.notePath);
    const view = file instanceof TFile ? this.markdownViewFor(file) : null;
    if (!view?.file || !view.editor.somethingSelected()) {
      new Notice('Select the passage in the note first, then choose Reattach.');
      return;
    }
    const editor = view.editor;
    const outcome = await this.controller.reattach(
      threadId,
      view.file.path,
      editor.getValue(),
      editor.posToOffset(editor.getCursor('from')),
      editor.posToOffset(editor.getCursor('to')),
    );
    if (!outcome.ok) new Notice(outcome.message);
    await this.refresh();
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ThreadglyphSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class ThreadglyphSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ThreadglyphPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName('Your name')
      .setDesc('Shown as the author of comments you write.')
      .addText((text) =>
        text.setValue(this.plugin.settings.authorName).onChange(async (value) => {
          this.plugin.settings.authorName = value.trim() || DEFAULT_SETTINGS.authorName;
          await this.plugin.saveSettings();
        }),
      );
  }
}
