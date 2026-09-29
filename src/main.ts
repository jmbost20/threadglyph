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
import { defaultAdapter, type AiSettings } from './ai/defaultAdapter';
import { aiPreview, buildAiRequest, type RequestInputs } from './ai/request';
import { AiSessions, type BuiltRequest, type ContextScope } from './ai/session';
import type { AiAdapter } from './ai/types';
import { embedAtSelection, imageSupport, isRemote, prepareImage, type ImageEmbed } from './anchor/imageEmbed';
import { ThreadController, type Outcome } from './controller';
import { THREADS_DIR } from './storage/paths';
import { AdapterFileStore } from './storage/adapterFileStore';
import { ThreadStore } from './storage/threadStore';
import { ThreadPanel, VIEW_TYPE_THREADGLYPH, type AiCardView, type PanelActions } from './ui/ThreadPanel';
import { setThreadMarks, threadMarksExtension, type ThreadMark } from './ui/editorMarks';
import { lineOffset, markRenderedSection, readingMarks } from './ui/readingMarks';
import { buildThreadViews, type ThreadFilter, type ThreadView } from './ui/viewModel';

interface ThreadglyphSettings extends AiSettings {
  authorName: string;
}

const DEFAULT_SETTINGS: ThreadglyphSettings = {
  authorName: 'Me',
  // AI is opt-in: human comments never need a model.
  aiEnabled: false,
  claudePath: '',
  aiModel: '',
  aiTimeoutSeconds: 120,
};

const aiDraftKey = (threadId: string) => `ai:${threadId}`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  private ai!: AiSessions;
  /** Builds the AI adapter from settings; replaceable so tests never start a real process. */
  adapterFactory: (settings: AiSettings) => AiAdapter | null = defaultAdapter;
  private adapterCache: { key: string; factory: unknown; adapter: AiAdapter | null } | null = null;

  private readonly scheduleRefresh = debounce(() => void this.refresh(), 300, true);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.ai = new AiSessions(() => void this.refresh());
    this.store = new ThreadStore(new AdapterFileStore(this.app.vault.adapter));
    this.controller = new ThreadController(this.store, () => ({ kind: 'human', name: this.settings.authorName }));

    this.registerView(VIEW_TYPE_THREADGLYPH, (leaf) => new ThreadPanel(leaf, this.panelActions()));
    this.registerEditorExtension(threadMarksExtension((id, source) => void this.focusThread(id, source !== 'text')));
    this.registerMarkdownPostProcessor((el, ctx) => this.decorateReading(el, ctx));

    this.addCommand({
      id: 'comment-on-selection',
      name: 'Comment on selection',
      editorCheckCallback: (checking, editor, ctx) => {
        if (!ctx.file || (!editor.somethingSelected() && !this.imageAtCursor(editor))) return false;
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
        if (!file) return;
        const onImage = this.imageAtCursor(editor) !== null;
        if (!editor.somethingSelected() && !onImage) return;
        menu.addItem((item) =>
          item
            .setTitle(onImage ? 'Threadglyph: comment on image' : 'Threadglyph: comment on selection')
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
    this.ai?.closeAll();
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
          if (result.ok && result.thread) {
            this.focusedThreadId = result.thread.id;
            if (this.mentionsAssistant(body)) this.ai.open(result.thread.id);
          }
          return result;
        }),
      cancelNewThread: () => {
        c.cancelThread();
        void this.refresh();
      },
      reply: (id, body) =>
        attempt(async () => {
          const result = await c.reply(id, body);
          if (result.ok && this.mentionsAssistant(body)) this.ai.open(id);
          return result;
        }),
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
      aiOpen: (id) => this.ai.open(id),
      aiScope: (id, scope) => this.ai.setScope(id, scope),
      aiSend: (id) => {
        const adapter = this.adapter();
        if (!adapter) return;
        // An edit of the previous answer must not stand in for the new one.
        c.drafts.delete(aiDraftKey(id));
        void this.ai.send(id, adapter, (scope) => this.buildRequest(id, scope));
      },
      aiCancel: (id) => {
        c.drafts.delete(aiDraftKey(id));
        this.ai.cancel(id);
      },
      aiClose: (id) => {
        c.drafts.delete(aiDraftKey(id));
        this.ai.close(id);
      },
      aiAdopt: async (id, body) => {
        const state = this.ai.get(id);
        const adapter = this.adapter();
        if (state?.phase !== 'draft' || !adapter) return false;
        const edited = body.trim() !== state.text.trim();
        const ok = await attempt(() => c.addAiReply(id, adapter.name, body, edited));
        if (ok) this.ai.close(id);
        return ok;
      },
      imageSrc: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? this.app.vault.getResourcePath(file) : null;
      },
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
      assistant: this.adapter()?.name ?? null,
    };
    if (!this.loaded || !note) {
      for (const panel of panels) {
        panel.update({
          ...base,
          status: this.loaded ? 'no-note' : 'loading',
          views: [],
          pendingQuote: null,
          pendingImagePath: null,
          ai: {},
        });
      }
      return;
    }
    const doc = await this.noteText(note);
    const views = buildThreadViews(this.store, note.path, doc, this.resolveLink);
    const ai = this.aiCards(note, doc, views);
    const pending = this.controller.pending?.notePath === note.path ? this.controller.pending : null;
    const pendingQuote = pending?.anchor.quote ?? null;
    const pendingImagePath = pending?.anchor.imagePath ?? null;
    for (const panel of panels) panel.update({ ...base, status: 'ready', views, pendingQuote, pendingImagePath, ai });
  }

  // ── AI ──────────────────────────────────────────────────────────────────────

  /** The adapter for the current AI settings, built once per settings change (it probes the disk for the CLI). */
  private adapter(): AiAdapter | null {
    const { aiEnabled, claudePath, aiModel, aiTimeoutSeconds } = this.settings;
    const key = JSON.stringify([aiEnabled, claudePath, aiModel, aiTimeoutSeconds]);
    if (this.adapterCache?.key !== key || this.adapterCache.factory !== this.adapterFactory) {
      this.adapterCache = { key, factory: this.adapterFactory, adapter: this.adapterFactory(this.settings) };
    }
    return this.adapterCache.adapter;
  }

  /** True when a comment @-mentions the enabled assistant, e.g. "@Claude". */
  private mentionsAssistant(body: string): boolean {
    const adapter = this.adapter();
    return !!adapter && new RegExp(`(^|\\s)@${escapeRegExp(adapter.name)}\\b`, 'i').test(body);
  }

  private requestInputs(note: TFile, doc: string, view: ThreadView): RequestInputs {
    const found = view.anchor.kind === 'found' ? view.anchor : null;
    return {
      noteName: note.basename,
      doc,
      thread: view.thread,
      quote: found ? doc.slice(found.from, found.to) : view.quote,
      anchorOffset: found?.from ?? null,
      imagePath: view.imagePath,
    };
  }

  private aiCards(note: TFile, doc: string, views: ThreadView[]): Record<string, AiCardView> {
    const cards: Record<string, AiCardView> = {};
    if (!this.adapter()) return cards;
    for (const view of views) {
      const state = this.ai.get(view.thread.id);
      if (!state) continue;
      const preview = aiPreview(this.requestInputs(note, doc, view), state.scope);
      cards[view.thread.id] = { state, ...preview, canSend: this.ai.canSend(view.thread.id) };
    }
    return cards;
  }

  /** Assembles the request at send time, reading the image's real bytes. */
  private async buildRequest(threadId: string, scope: ContextScope): Promise<BuiltRequest> {
    const thread = this.store.get(threadId);
    const file = thread && this.app.vault.getAbstractFileByPath(thread.notePath);
    if (!thread || !(file instanceof TFile)) return { ok: false, message: 'The note for this thread is missing.' };
    const doc = await this.noteText(file);
    const [view] = buildThreadViews(
      { forNote: () => [thread], anchorFor: (id) => this.store.anchorFor(id) },
      file.path,
      doc,
      this.resolveLink,
    );
    const inputs = this.requestInputs(file, doc, view);
    if (!inputs.imagePath) return { ok: true, request: buildAiRequest(inputs, scope, null) };
    const imageFile = this.app.vault.getAbstractFileByPath(inputs.imagePath);
    if (!(imageFile instanceof TFile)) return { ok: false, message: `Image file not found: ${inputs.imagePath}` };
    const prepared = prepareImage(imageFile.path, new Uint8Array(await this.app.vault.readBinary(imageFile)));
    if (!prepared.ok) return { ok: false, message: prepared.reason };
    return { ok: true, request: buildAiRequest(inputs, scope, prepared.image) };
  }

  /** Threads of a note with their anchors resolved against `doc`; empty until storage has loaded. */
  private anchoredViews(notePath: string, doc: string): ThreadView[] {
    if (!this.loaded || !this.store.hasThreads(notePath)) return [];
    return buildThreadViews(this.store, notePath, doc, this.resolveLink);
  }

  /** Obsidian's own link resolution, so embeds resolve exactly as the app shows them. */
  private readonly resolveLink = (link: string, fromNote: string): string | null =>
    isRemote(link) ? null : (this.app.metadataCache.getFirstLinkpathDest(link, fromNote)?.path ?? null);

  /** The image embed under the cursor or selection, if any. */
  private imageAtCursor(editor: Editor): ImageEmbed | null {
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    const embed = embedAtSelection(editor.getValue(), from, to);
    // A text selection that merely contains an image stays a text comment.
    return embed && embed.from <= from && to <= embed.to ? embed : null;
  }

  /** The vault file an embed shows, or a message saying why it cannot be used. */
  private imageFile(embed: ImageEmbed, notePath: string): { path: string } | { message: string } {
    if (isRemote(embed.link)) return { message: (imageSupport(embed.link) as { reason: string }).reason };
    const path = this.resolveLink(embed.link, notePath);
    return path ? { path } : { message: `Image file not found in this vault: ${embed.link}` };
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
    const signature = JSON.stringify(readingMarks(views, view.editor.getValue()));
    if (this.readingSignatures.get(view) === signature) return;
    this.readingSignatures.set(view, signature);
    view.previewMode?.rerender(true);
  }

  private decorateReading(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    const marks = readingMarks(this.anchoredViews(ctx.sourcePath, info.text), info.text);
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

  /** Starts a thread on the selected text, or on the image embed under the cursor. */
  private async beginThread(editor: Editor, file: TFile): Promise<void> {
    const doc = editor.getValue();
    const embed = this.imageAtCursor(editor);
    let outcome: Outcome;
    if (embed) {
      const image = this.imageFile(embed, file.path);
      outcome =
        'path' in image
          ? this.controller.beginImageThread(file.path, doc, embed.from, embed.to, image.path)
          : { ok: false, message: image.message };
    } else {
      const from = editor.posToOffset(editor.getCursor('from'));
      const to = editor.posToOffset(editor.getCursor('to'));
      outcome = this.controller.beginThread(file.path, doc, from, to);
    }
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
      this.resolveLink,
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
    const image = thread?.anchorKind === 'image';
    const embed = view && image ? this.imageAtCursor(view.editor) : null;
    if (!view?.file || (image ? !embed : !view.editor.somethingSelected())) {
      new Notice(
        image
          ? 'Put the cursor on the image embed in the note first, then choose Reattach.'
          : 'Select the passage in the note first, then choose Reattach.',
      );
      return;
    }
    const editor = view.editor;
    let outcome: Outcome;
    if (embed) {
      const target = this.imageFile(embed, view.file.path);
      outcome =
        'path' in target
          ? await this.controller.reattach(threadId, view.file.path, editor.getValue(), embed.from, embed.to, target.path)
          : { ok: false, message: target.message };
    } else {
      outcome = await this.controller.reattach(
        threadId,
        view.file.path,
        editor.getValue(),
        editor.posToOffset(editor.getCursor('from')),
        editor.posToOffset(editor.getCursor('to')),
      );
    }
    if (!outcome.ok) new Notice(outcome.message);
    await this.refresh();
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ThreadglyphSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Switching AI off stops any running request and removes its cards; either way the panel updates now.
    if (!this.settings.aiEnabled) this.ai?.closeAll();
    await this.refresh();
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

    new Setting(this.containerEl).setName('AI assistant').setHeading();
    new Setting(this.containerEl)
      .setName('Enable Ask Claude')
      .setDesc(
        'Adds “Ask Claude” to threads and @Claude to comment boxes. Requests run through your local Claude Code ' +
          'sign-in with every tool disabled. Nothing is sent until you press Send in the preview.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.aiEnabled).onChange(async (value) => {
          this.plugin.settings.aiEnabled = value;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName('Claude Code path')
      .setDesc('Leave blank to look in the usual install locations (~/.local/bin/claude and others).')
      .addText((text) =>
        text.setValue(this.plugin.settings.claudePath).onChange(async (value) => {
          this.plugin.settings.claudePath = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName('Model')
      .setDesc('Optional, e.g. “sonnet”. Blank uses Claude Code’s default.')
      .addText((text) =>
        text.setValue(this.plugin.settings.aiModel).onChange(async (value) => {
          this.plugin.settings.aiModel = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName('Timeout (seconds)')
      .setDesc('How long to wait for a reply before giving up.')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.aiTimeoutSeconds)).onChange(async (value) => {
          const seconds = Number.parseInt(value, 10);
          this.plugin.settings.aiTimeoutSeconds = Number.isFinite(seconds) && seconds >= 10 ? seconds : DEFAULT_SETTINGS.aiTimeoutSeconds;
          await this.plugin.saveSettings();
        }),
      );
  }
}
