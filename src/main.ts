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
import {
  ASSISTANT_IDS,
  DEFAULT_AI_SETTINGS,
  defaultAssistants,
  geminiFolderPath,
  migrateAiSettings,
  preferredAssistant,
  type AiSettings,
  type AssistantId,
} from './ai/assistants';
import { aiPreview, buildAiRequest, type RequestInputs } from './ai/request';
import { AiSessions, type BuiltRequest, type ContextScope } from './ai/session';
import type { AiAdapter } from './ai/types';
import { embedAtSelection, imageSupport, isRemote, prepareImage, type ImageEmbed } from './anchor/imageEmbed';
import { ThreadController, type Outcome } from './controller';
import { planImport } from './import/inlineComments';
import { EXPORTS_DIR, buildExport, exportFileName, parseExport } from './storage/backup';
import { THREADS_DIR } from './storage/paths';
import { ImportModal, RestoreModal } from './ui/modals';
import { AdapterFileStore } from './storage/adapterFileStore';
import { ThreadStore } from './storage/threadStore';
import { ThreadPanel, VIEW_TYPE_THREADGLYPH, type AiCardView, type PanelActions } from './ui/ThreadPanel';
import { setThreadMarks, threadMarksExtension, type ThreadMark } from './ui/editorMarks';
import { imageTitlesExtension, titleRenderedImages } from './ui/imageTitles';
import { clearReadingMarks, lineOffset, markRenderedSection, readingMarks } from './ui/readingMarks';
import { buildThreadViews, type ThreadFilter, type ThreadView } from './ui/viewModel';

interface ThreadglyphSettings extends AiSettings {
  authorName: string;
}

const DEFAULT_SETTINGS: ThreadglyphSettings = {
  authorName: 'Me',
  ...DEFAULT_AI_SETTINGS,
};

const ASSISTANT_LABELS: Record<AssistantId, string> = {
  local: 'Local (Ollama on this computer)',
  gemini: 'Gemini (Gemini CLI, sent to Google)',
  claude: 'Claude (Claude Code, sent to Anthropic)',
};

/** Where an assistant's requests go, in words for the preview. */
export function destination(adapter: AiAdapter): string {
  if (adapter.egress === 'local') return 'Stays on this computer';
  if (adapter.recipient) return `Sent to ${adapter.recipient}`;
  const where: Record<string, string> = { gemini: 'Google', claude: 'Anthropic', local: 'ollama.com' };
  return `Sent to ${where[adapter.id] ?? 'the provider'}`;
}

const aiDraftKey = (threadId: string) => `ai:${threadId}`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cmView(view: MarkdownView): EditorView | null {
  return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
}

export default class ThreadglyphPlugin extends Plugin {
  settings: ThreadglyphSettings = DEFAULT_SETTINGS;
  private files!: AdapterFileStore;
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
  /** The comment whose @mention opened each thread's Ask AI preview, until it is sent. */
  private readonly aiQuestions = new Map<string, string>();
  /** For each open Ask AI preview, what it last showed (see requestFingerprint). */
  private readonly shownRequests = new Map<string, string>();
  /** Builds the enabled assistants from settings; replaceable so tests never start a real process. */
  adapterFactory: (settings: AiSettings) => AiAdapter[] = defaultAssistants;
  private adapterCache: { key: string; factory: unknown; adapters: AiAdapter[] } | null = null;

  private readonly scheduleRefresh = debounce(() => void this.refresh(), 300, true);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.ai = new AiSessions(() => void this.refresh());
    this.files = new AdapterFileStore(this.app.vault.adapter);
    this.store = new ThreadStore(this.files);
    this.controller = new ThreadController(this.store, () => ({ kind: 'human', name: this.settings.authorName }));

    this.registerView(VIEW_TYPE_THREADGLYPH, (leaf) => new ThreadPanel(leaf, this.panelActions()));
    this.registerEditorExtension(threadMarksExtension((id, source) => void this.focusThread(id, source !== 'text')));
    this.registerEditorExtension(imageTitlesExtension((cm, embed) => void this.commentOnImageIn(cm, embed)));
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
    this.addCommand({
      id: 'search-threads',
      name: 'Search threads',
      callback: async () => (await this.activatePanel())?.focusSearch(),
    });
    this.addCommand({
      id: 'import-inline-comments',
      name: 'Import inline comments from this note',
      editorCheckCallback: (checking, editor, ctx) => {
        if (!ctx.file || !this.loaded || !editor.getValue().includes('{>>')) return false;
        if (!checking) this.previewImport(ctx.file, editor.getValue());
        return true;
      },
    });
    this.addCommand({
      id: 'back-up-threads',
      name: 'Back up all threads',
      callback: () => void this.backUp(),
    });
    this.addCommand({
      id: 'restore-threads',
      name: 'Restore threads from a backup',
      callback: async () => new RestoreModal(this.app, await this.files.list(EXPORTS_DIR), (path) => this.restore(path)).open(),
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
    // Rendered Markdown keeps post-processed output until it re-renders, so take the marks out now:
    // Reading views, Canvas cards and hover previews, in the main window and any pop-out window.
    const docs = new Set<Document>([document]);
    this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.ownerDocument));
    for (const doc of docs) doc.body.querySelectorAll('.markdown-rendered, .markdown-preview-view').forEach(clearReadingMarks);
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
            const mentioned = this.mentionedAssistant(body);
            if (mentioned) {
              this.ai.open(result.thread.id, mentioned.id);
              this.aiQuestions.set(result.thread.id, result.thread.messages[0].id);
            }
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
          const mentioned = result.ok ? this.mentionedAssistant(body) : null;
          if (mentioned) {
            this.ai.open(id, mentioned.id);
            const question = this.store.get(id)?.messages.at(-1);
            if (question) this.aiQuestions.set(id, question.id);
          }
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
      setMessageDeleted: async (id, messageId, deleted) => {
        if (this.ai.get(id)?.phase === 'saving') {
          new Notice('The AI reply is saving. Try deleting again in a moment.');
          return false;
        }
        this.ai.close(id);
        const ok = await attempt(() => c.setMessageDeleted(id, messageId, deleted));
        await this.refresh();
        return ok;
      },
      setThreadDeleted: async (id, deleted) => {
        if (this.ai.get(id)?.phase === 'saving') {
          new Notice('The AI reply is saving. Try deleting again in a moment.');
          return false;
        }
        this.ai.close(id);
        const ok = await attempt(() => c.setThreadDeleted(id, deleted));
        await this.refresh();
        return ok;
      },
      setResolved: async (id, resolved) => {
        await attempt(() => c.setResolved(id, resolved));
        await this.refresh();
      },
      reattach: (id) => this.reattach(id),
      aiOpen: (id, assistant) => {
        const chosen = assistant ?? preferredAssistant(this.assistants(), this.settings.defaultAssistant)?.id;
        if (chosen) this.ai.open(id, chosen);
      },
      aiScope: (id, scope) => this.ai.setScope(id, scope),
      aiAssistant: (id, assistant) => this.ai.setAssistant(id, assistant),
      aiSend: (id) => {
        if (!this.assistants().length) return;
        // An edit of the previous answer must not stand in for the new one.
        c.drafts.delete(aiDraftKey(id));
        void this.ai.send(
          id,
          (assistant) => this.findAssistant(assistant),
          async (scope) => {
            const built = await this.buildRequest(id, scope);
            // Once it goes out, the question belongs to the thread and Escape no longer discards it.
            // A Send that comes back to the preview leaves it discardable.
            if (built.ok) this.aiQuestions.delete(id);
            return built;
          },
          (assistant, body, edited) => attempt(() => c.addAiReply(id, this.findAssistant(assistant)?.name ?? assistant, body, edited)),
        );
      },
      aiCancel: (id) => {
        c.drafts.delete(aiDraftKey(id));
        this.ai.cancel(id);
      },
      aiClose: (id, discardQuestion) => {
        c.drafts.delete(aiDraftKey(id));
        this.shownRequests.delete(id);
        this.ai.close(id);
        const question = this.aiQuestions.get(id);
        this.aiQuestions.delete(id);
        if (discardQuestion && question) {
          void attempt(() => c.setMessageDeleted(id, question, true)).then(() => this.refresh());
        }
      },
      aiAdopt: (id, body) => this.ai.adopt(id, body, (assistant, text, edited) =>
        attempt(() => c.addAiReply(id, this.findAssistant(assistant)?.name ?? assistant, text, edited))),
      imageSrc: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? this.app.vault.getResourcePath(file) : null;
      },
      goTo: (id) => this.goTo(id),
      select: (id) => this.revealPassage(id, false),
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
    const threads = note ? this.store.forNote(note.path) : [];
    // A thread with every comment deleted is listed once, to restore as a whole.
    const gone = threads.filter((t) => t.messages.every((m) => m.deletedAt));
    const deletedMessages = threads.filter((t) => !gone.includes(t)).flatMap((t) =>
      t.messages.filter((m) => m.deletedAt).map((message) => ({ threadId: t.id, message })));
    // Restore brings back the comments deleted with the thread (the latest deletion), so count and preview those.
    const deletedThreads = gone.map((t) => {
      const last = t.messages.reduce((max, m) => (m.deletedAt! > max ? m.deletedAt! : max), '');
      const restored = t.messages.filter((m) => m.deletedAt === last);
      return { threadId: t.id, preview: restored[0]?.body ?? '', count: restored.length };
    });
    const base = {
      deletedMessages,
      deletedThreads,
      notePath: note?.path ?? null,
      noteName: note?.basename ?? '',
      problems: this.store.loadProblems(),
      focusedThreadId: this.focusedThreadId,
      filter: this.filter,
      assistants: this.assistants().map((a) => ({ id: a.id, name: a.name, detail: a.detail, destination: destination(a) })),
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

  /** The enabled assistants, rebuilt only when AI settings change (building one probes the disk for its CLI). */
  private assistants(): AiAdapter[] {
    const key = JSON.stringify({ ...this.settings, authorName: '' });
    if (this.adapterCache?.key !== key || this.adapterCache.factory !== this.adapterFactory) {
      this.adapterCache = { key, factory: this.adapterFactory, adapters: this.adapterFactory(this.settings) };
    }
    return this.adapterCache.adapters;
  }

  private findAssistant(id: string): AiAdapter | null {
    return this.assistants().find((a) => a.id === id) ?? null;
  }

  /** The first enabled assistant a comment @-mentions, e.g. "@Local" or "@Gemini". */
  private mentionedAssistant(body: string): AiAdapter | null {
    let first: { adapter: AiAdapter; at: number } | null = null;
    for (const adapter of this.assistants()) {
      const at = body.search(new RegExp(String.raw`(^|\s)@${escapeRegExp(adapter.name)}\b`, 'i'));
      if (at !== -1 && (!first || at < first.at)) first = { adapter, at };
    }
    return first?.adapter ?? null;
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
    if (!this.assistants().length) return cards;
    for (const view of views) {
      const state = this.ai.get(view.thread.id);
      if (!state) continue;
      const inputs = this.requestInputs(note, doc, view);
      const preview = aiPreview(inputs, state.scope);
      if (state.phase === 'preview') this.shownRequests.set(view.thread.id, this.requestFingerprint(inputs, preview.exactText, state.assistant));
      cards[view.thread.id] = { state, ...preview, canSend: this.ai.canSend(view.thread.id) };
    }
    return cards;
  }

  /**
   * What a preview showed, as one string: the exact text, where it goes, and which version of
   * the image. Send compares it with the request it is about to make.
   */
  private requestFingerprint(inputs: RequestInputs, exactText: string, assistant: string): string {
    const adapter = this.findAssistant(assistant);
    const image = inputs.imagePath ? this.app.vault.getAbstractFileByPath(inputs.imagePath) : null;
    const version = image instanceof TFile ? `${image.stat.mtime}:${image.stat.size}` : null;
    return JSON.stringify([exactText, adapter ? destination(adapter) : null, inputs.imagePath, version]);
  }

  /**
   * Assembles the request at send time, reading the image's real bytes. It goes only if it
   * still matches the preview the user last saw; otherwise the preview is shown again.
   */
  private async buildRequest(threadId: string, scope: ContextScope): Promise<BuiltRequest> {
    const stale: BuiltRequest = { ok: false, stale: true, message: 'The note changed since this preview. Check it and send again.' };
    const assistant = this.ai.get(threadId)?.assistant;
    const shown = this.shownRequests.get(threadId);
    const matches = (inputs: RequestInputs) =>
      assistant !== undefined && shown === this.requestFingerprint(inputs, aiPreview(inputs, scope).exactText, assistant);
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
    const imageFile = inputs.imagePath ? this.app.vault.getAbstractFileByPath(inputs.imagePath) : null;
    if (inputs.imagePath && !(imageFile instanceof TFile)) return { ok: false, message: `Image file not found: ${inputs.imagePath}` };
    if (!matches(inputs)) return stale;
    if (!(imageFile instanceof TFile)) return { ok: true, request: buildAiRequest(inputs, scope, null) };
    const prepared = prepareImage(imageFile.path, new Uint8Array(await this.app.vault.readBinary(imageFile)));
    if (!prepared.ok) return { ok: false, message: prepared.reason };
    // The image may have been replaced while its bytes were read.
    if (!matches(inputs)) return stale;
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
    const start = lineOffset(info.text, info.lineStart);
    const end = lineOffset(info.text, info.lineEnd + 1);
    const marks = readingMarks(this.anchoredViews(ctx.sourcePath, info.text), info.text);
    if (marks.length) markRenderedSection(el, info.text, start, end, marks, (id) => void this.focusThread(id, false));
    titleRenderedImages(el, info.text, start, end, (embed) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (file instanceof TFile) void this.startImageThread(file, info.text, embed);
    });
  }

  /** The Comment button on an image title in an editor. */
  private async commentOnImageIn(cm: EditorView, embed: ImageEmbed): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && cmView(view) === cm) {
        await this.startImageThread(view.file, view.editor.getValue(), embed);
        return;
      }
    }
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
    const embed = this.imageAtCursor(editor);
    if (embed) return this.startImageThread(file, editor.getValue(), embed);
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    await this.openNewThread(file, this.controller.beginThread(file.path, editor.getValue(), from, to));
  }

  /** Starts a thread on an image embed of `file`, whose current text is `doc`. */
  private async startImageThread(file: TFile, doc: string, embed: ImageEmbed): Promise<void> {
    const image = this.imageFile(embed, file.path);
    await this.openNewThread(
      file,
      'path' in image
        ? this.controller.beginImageThread(file.path, doc, embed.from, embed.to, image.path)
        : { ok: false, message: image.message },
    );
  }

  private async openNewThread(file: TFile, outcome: Outcome): Promise<void> {
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

  private goTo(threadId: string): Promise<void> {
    return this.revealPassage(threadId, true);
  }

  /**
   * Selects a thread's passage in its note and makes it the focused card.
   * With `focusEditor` false (panel navigation) the keyboard stays in the panel.
   */
  private async revealPassage(threadId: string, focusEditor: boolean): Promise<void> {
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
    if (match?.anchor.kind === 'found') {
      if (focusEditor) this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
      const from = view.editor.offsetToPos(match.anchor.from);
      const to = view.editor.offsetToPos(match.anchor.to);
      view.editor.setSelection(from, to);
      view.editor.scrollIntoView({ from, to }, true);
    } else if (focusEditor) {
      new Notice('This thread’s passage could not be located.');
      return;
    }
    // Panel navigation still steps onto a thread whose passage is gone; it just has nothing to highlight.
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

  // ── Import, backup and restore ──────────────────────────────────────────────

  /** Shows what importing this note's inline comments would do; nothing is written before Import. */
  private previewImport(file: TFile, doc: string): void {
    const existing = this.store.forNote(file.path).map((t) => ({
      quote: this.store.anchorFor(t.id)?.quote ?? null,
      firstBody: t.messages[0]?.body ?? null,
    }));
    const items = planImport(doc, existing);
    const people = { assistants: ['Claude', 'Codex', 'Gemini', 'Local', ...this.assistants().map((a) => a.name)], you: this.settings.authorName };
    new ImportModal(this.app, file.basename, items, async () => {
      let imported = 0;
      for (const item of items) {
        if (item.status !== 'new') continue;
        const outcome = await this.controller.importLegacy(file.path, doc, item.legacy, people);
        if (outcome.ok) imported++;
        else new Notice(outcome.message);
      }
      new Notice(`Threadglyph imported ${imported} thread(s). The note was not changed.`);
      this.currentFile = file;
      await this.activatePanel();
    }).open();
  }

  /** Writes every thread and anchor to one file in the local-only exports folder. */
  async backUp(): Promise<string> {
    const now = new Date();
    const path = exportFileName(now);
    const { threads, anchors } = this.store.snapshot();
    await this.files.ensureDir(EXPORTS_DIR);
    await this.files.write(path, buildExport(threads, anchors, now));
    new Notice(`Threadglyph backed up ${threads.length} thread(s) to ${path}`);
    return path;
  }

  /** Adds the threads from a backup that are missing here. */
  async restore(path: string): Promise<void> {
    const raw = await this.files.read(path);
    const parsed = raw === null ? { ok: false as const, error: 'file not found' } : parseExport(raw);
    if (!parsed.ok) {
      new Notice(`Threadglyph could not restore ${path}: ${parsed.error}. Nothing was changed.`);
      return;
    }
    let restored = 0;
    let existed = 0;
    for (const thread of parsed.value.threads) {
      if ((await this.store.restore(thread, parsed.value.anchors.get(thread.id))) === 'restored') restored++;
      else existed++;
    }
    const skipped = parsed.value.invalid ? `, ${parsed.value.invalid} invalid record(s) skipped` : '';
    new Notice(`Threadglyph restored ${restored} thread(s); ${existed} already existed${skipped}.`);
    await this.refresh();
  }

  async loadSettings(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    const authorName = typeof saved.authorName === 'string' ? saved.authorName : DEFAULT_SETTINGS.authorName;
    this.settings = { ...migrateAiSettings(saved), authorName };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Switching AI off stops any running request and removes its cards; either way the panel updates now.
    if (!this.settings.aiEnabled) {
      this.ai?.closeAll();
    }
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

    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    const text = (name: string, desc: string, get: () => string, set: (value: string) => void) =>
      new Setting(this.containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(get()).onChange(async (value) => {
            set(value.trim());
            await save();
          }),
        );

    new Setting(this.containerEl).setName('AI assistants').setHeading();
    new Setting(this.containerEl)
      .setName('Enable Ask AI')
      .setDesc(
        'Adds “Ask AI” to threads and @Local, @Gemini or @Claude to comment boxes. Nothing is sent until you press ' +
          'Send in the preview, which shows exactly what goes and where.',
      )
      .addToggle((toggle) =>
        toggle.setValue(s.aiEnabled).onChange(async (value) => {
          s.aiEnabled = value;
          await save();
        }),
      );
    for (const id of ASSISTANT_IDS) {
      new Setting(this.containerEl).setName(ASSISTANT_LABELS[id]).addToggle((toggle) =>
        toggle.setValue(s.assistants[id]).onChange(async (value) => {
          s.assistants = { ...s.assistants, [id]: value };
          await save();
        }),
      );
    }
    new Setting(this.containerEl)
      .setName('Preferred assistant')
      .setDesc('Chosen first in the Ask AI preview. You can switch per request.')
      .addDropdown((dropdown) => {
        for (const id of ASSISTANT_IDS) dropdown.addOption(id, ASSISTANT_LABELS[id]);
        dropdown.setValue(s.defaultAssistant).onChange(async (value) => {
          s.defaultAssistant = value as AssistantId;
          await save();
        });
      });

    new Setting(this.containerEl).setName('Local (Ollama)').setHeading();
    text('Ollama address', `Default ${DEFAULT_AI_SETTINGS.ollamaHost}. An address on another machine is shown as leaving this computer.`, () => s.ollamaHost, (v) => {
      s.ollamaHost = v || DEFAULT_AI_SETTINGS.ollamaHost;
    });
    text('Model', 'An installed Ollama model, e.g. qwen3:8b. Image threads need a vision model such as qwen2.5vl:7b.', () => s.ollamaModel, (v) => {
      s.ollamaModel = v || DEFAULT_AI_SETTINGS.ollamaModel;
    });

    new Setting(this.containerEl).setName('Gemini').setHeading();
    text('Gemini CLI path', 'Leave blank to look in the usual install locations.', () => s.geminiPath, (v) => {
      s.geminiPath = v;
    });
    text('Model', `Default ${DEFAULT_AI_SETTINGS.geminiModel}. If it is overloaded, try gemini-3.1-flash-lite.`, () => s.geminiModel, (v) => {
      s.geminiModel = v || DEFAULT_AI_SETTINGS.geminiModel;
    });
    text(
      'Gemini folder',
      `Where Gemini CLI runs, never your vault. Your key goes in ${geminiFolderPath(s)}/.gemini/.env as GEMINI_API_KEY=…`,
      () => s.geminiFolder,
      (v) => {
        s.geminiFolder = v;
      },
    );

    new Setting(this.containerEl).setName('Claude').setHeading();
    text('Claude Code path', 'Leave blank to look in the usual install locations (~/.local/bin/claude and others).', () => s.claudePath, (v) => {
      s.claudePath = v;
    });
    text('Model', 'Optional, e.g. “sonnet”. Blank uses Claude Code’s default.', () => s.claudeModel, (v) => {
      s.claudeModel = v;
    });

    new Setting(this.containerEl).setName('All assistants').setHeading();
    text('Timeout (seconds)', 'How long to wait for a reply before giving up.', () => String(s.aiTimeoutSeconds), (v) => {
      const seconds = Number.parseInt(v, 10);
      s.aiTimeoutSeconds = Number.isFinite(seconds) && seconds >= 10 ? seconds : DEFAULT_SETTINGS.aiTimeoutSeconds;
    });
  }
}
