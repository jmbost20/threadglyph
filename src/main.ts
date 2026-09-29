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
  type Editor,
  type MarkdownPostProcessorContext,
} from 'obsidian';
import { ThreadController, type Outcome } from './controller';
import { THREADS_DIR } from './storage/paths';
import { AdapterFileStore } from './storage/adapterFileStore';
import { ThreadStore } from './storage/threadStore';
import { ThreadPanel, VIEW_TYPE_THREADGLYPH, type PanelActions } from './ui/ThreadPanel';
import { setThreadMarks, threadMarksExtension, type ThreadMark } from './ui/editorMarks';
import { lineOffset, markRenderedSection, readingMarks } from './ui/readingMarks';
import { buildThreadViews, type ThreadFilter, type ThreadView } from './ui/viewModel';

interface ThreadglyphSettings {
  authorName: string;
}

const DEFAULT_SETTINGS: ThreadglyphSettings = { authorName: 'Me' };

function cmView(view: MarkdownView): EditorView | null {
  return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
}

export default class ThreadglyphPlugin extends Plugin {
  settings: ThreadglyphSettings = DEFAULT_SETTINGS;
  private store!: ThreadStore;
  private controller!: ThreadController;
  private loaded = false;
  private filter: ThreadFilter = 'open';
  /** Marks each Reading view last rendered with, so a view re-renders only when its threads change. */
  private readonly readingSignatures = new WeakMap<MarkdownView, string>();
  private focusedThreadId: string | null = null;
  /** The note the panel is showing; kept when focus moves into the panel itself. */
  private currentFile: TFile | null = null;

  private readonly scheduleRefresh = debounce(() => void this.refresh(), 300, true);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new ThreadStore(new AdapterFileStore(this.app.vault.adapter));
    this.controller = new ThreadController(this.store, () => ({ kind: 'human', name: this.settings.authorName }));

    this.registerView(VIEW_TYPE_THREADGLYPH, (leaf) => new ThreadPanel(leaf, this.panelActions()));
    this.registerEditorExtension(threadMarksExtension((id, source) => void this.focusThread(id, source !== 'text')));
    this.registerMarkdownPostProcessor((el, ctx) => this.decorateReading(el, ctx));

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
      id: 'next-thread',
      name: 'Go to next thread',
      editorCheckCallback: (checking, editor, ctx) => this.stepThread(checking, editor, ctx.file, 1),
    });
    this.addCommand({
      id: 'previous-thread',
      name: 'Go to previous thread',
      editorCheckCallback: (checking, editor, ctx) => this.stepThread(checking, editor, ctx.file, -1),
    });
    this.addCommand({
      id: 'reply-at-cursor',
      name: 'Reply to thread at cursor',
      editorCheckCallback: (checking, editor, ctx) => {
        const offset = editor.posToOffset(editor.getCursor('from'));
        const hit = ctx.file && this.anchoredViews(ctx.file.path, editor.getValue()).find(
          (v) => v.anchor.kind === 'found' && v.anchor.from <= offset && offset <= v.anchor.to,
        );
        if (!hit) return false;
        if (!checking) void this.focusThread(hit.thread.id, true);
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
      setFilter: (filter) => {
        this.filter = filter;
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
    if (active?.extension === 'md') this.currentFile = active;
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
      filter: this.filter,
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

  /** Threads of a note with their anchors resolved against `doc`; empty until storage has loaded. */
  private anchoredViews(notePath: string, doc: string): ThreadView[] {
    if (!this.loaded || !this.store.hasThreads(notePath)) return [];
    return buildThreadViews(this.store, notePath, doc);
  }

  /** Recomputes highlights, badges and margin glyphs for every open note. */
  private async updateEditorMarks(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const doc = view.editor.getValue();
      const views = this.anchoredViews(view.file.path, doc);
      this.rerenderReadingIfChanged(view, views);
      const cm = cmView(view);
      if (!cm) continue;
      const marks: ThreadMark[] = [];
      for (const v of views) {
        if (v.anchor.kind !== 'found') continue;
        marks.push({
          threadId: v.thread.id,
          from: v.anchor.from,
          to: v.anchor.to,
          resolved: v.thread.status === 'resolved',
          number: v.number,
          focused: v.thread.id === this.focusedThreadId,
        });
      }
      const pending = this.controller.pending;
      if (pending?.notePath === view.file.path) {
        const at = doc.indexOf(pending.anchor.prefix + pending.anchor.quote);
        const from = at === -1 ? -1 : at + pending.anchor.prefix.length;
        if (from >= 0) marks.push({ threadId: '', from, to: from + pending.anchor.quote.length, resolved: false, pending: true });
      }
      cm.dispatch({ effects: setThreadMarks.of(marks) });
    }
  }

  /** Reading view is rendered once per section; re-render it only when its threads change. */
  private rerenderReadingIfChanged(view: MarkdownView, views: ThreadView[]): void {
    // Source mode renders from scratch when the user switches to Reading, so only live previews need a nudge.
    if (view.getMode?.() !== 'preview') return;
    const signature = JSON.stringify(readingMarks(views));
    if (this.readingSignatures.get(view) === signature) return;
    this.readingSignatures.set(view, signature);
    view.previewMode?.rerender(true);
  }

  private decorateReading(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    const marks = readingMarks(this.anchoredViews(ctx.sourcePath, info.text));
    if (!marks.length) return;
    const start = lineOffset(info.text, info.lineStart);
    const end = lineOffset(info.text, info.lineEnd + 1);
    markRenderedSection(el, info.text, start, end, marks, (id) => void this.focusThread(id, false));
  }

  /** Moves the selection to the next or previous anchored passage, wrapping around the note. */
  private stepThread(checking: boolean, editor: Editor, file: TFile | null, direction: 1 | -1): boolean {
    if (!file) return false;
    const found = this.anchoredViews(file.path, editor.getValue())
      .flatMap((v) => (v.anchor.kind === 'found' ? [{ id: v.thread.id, from: v.anchor.from, to: v.anchor.to }] : []))
      .sort((a, b) => a.from - b.from);
    if (!found.length) return false;
    if (checking) return true;
    const cursor = editor.posToOffset(editor.getCursor('from'));
    const target =
      direction === 1
        ? (found.find((a) => a.from > cursor) ?? found[0])
        : ([...found].reverse().find((a) => a.from < cursor) ?? found[found.length - 1]);
    const from = editor.offsetToPos(target.from);
    const to = editor.offsetToPos(target.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    void this.focusThread(target.id, false);
    return true;
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

  /** Shows a thread's card; `focusComposer` moves the caret into its reply box. */
  private async focusThread(threadId: string, focusComposer = true): Promise<void> {
    this.focusedThreadId = threadId;
    const thread = this.store.get(threadId);
    if (thread && this.filter !== 'all' && thread.status !== this.filter) this.filter = 'all';
    const panel = await this.activatePanel();
    panel?.scrollToThread(threadId, focusComposer);
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
    await this.refresh();
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
