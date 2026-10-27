import { ItemView, Scope, type WorkspaceLeaf } from 'obsidian';
import type { AiState, ContextScope } from '../ai/session';
import type { Message } from '../model/types';
import type { LoadProblem } from '../storage/threadStore';
import { ConfirmDeleteModal } from './modals';
import {
  anchorProblem,
  EMPTY_COMMENT_FILTERS,
  hasCommentFilters,
  type CommentFilters,
  draftKey,
  filterViews,
  formatTimestamp,
  originLabel,
  previewQuote,
  type ThreadFilter,
  type ThreadView,
} from './viewModel';

export const VIEW_TYPE_THREADGLYPH = 'threadglyph-panel';

/** An open "Ask AI" session on one thread, with everything the preview must show. */
export interface AiCardView {
  state: AiState;
  /** One line per item that will be sent. */
  items: string[];
  scopes: { scope: ContextScope; label: string }[];
  /** The exact text of the request (images are named, not inlined). */
  exactText: string;
  canSend: boolean;
}

export interface PanelState {
  status: 'loading' | 'no-note' | 'ready';
  notePath: string | null;
  noteName: string;
  views: ThreadView[];
  deletedMessages?: { threadId: string; message: Message }[];
  /** Threads whose comments were all deleted, restorable as a whole. */
  deletedThreads?: { threadId: string; preview: string; count: number }[];
  pendingQuote: string | null;
  /** Image file of the pending selection, when the new thread is on an image. */
  pendingImagePath: string | null;
  problems: LoadProblem[];
  focusedThreadId: string | null;
  filter: ThreadFilter;
  /** Enabled assistants in preference order; empty when AI is off (no AI controls are shown). */
  assistants: AssistantInfo[];
  ai: Record<string, AiCardView>;
}

/** An assistant as the panel shows it. */
export interface AssistantInfo {
  id: string;
  name: string;
  /** The model or tool, e.g. `qwen3:8b`. */
  detail: string;
  /** Where a request goes, e.g. "Stays on this computer" or "Sent to Google". */
  destination: string;
}

/** What the panel may ask the plugin to do. All persistence lives behind this boundary. */
export interface PanelActions {
  drafts: Map<string, string>;
  editing: Set<string>;
  createThread(body: string): Promise<boolean>;
  cancelNewThread(): void;
  reply(threadId: string, body: string): Promise<boolean>;
  /** Enters edit mode and remembers the body being edited, to detect a stale save. */
  startEdit(threadId: string, messageId: string): void;
  saveEdit(threadId: string, messageId: string, body: string): Promise<boolean>;
  cancelEdit(threadId: string, messageId: string): void;
  setMessageDeleted(threadId: string, messageId: string, deleted: boolean): Promise<boolean>;
  /** Deletes or restores every comment of a thread at once. */
  setThreadDeleted(threadId: string, deleted: boolean): Promise<boolean>;
  setResolved(threadId: string, resolved: boolean): Promise<void>;
  reattach(threadId: string): Promise<void>;
  goTo(threadId: string): Promise<void>;
  /** Highlights the thread's passage and focuses its card, keeping the keyboard in the panel. */
  select(threadId: string): Promise<void>;
  /** A displayable URL for a vault image, or null when the file is missing. */
  imageSrc(path: string): string | null;
  /** Opens the Ask AI preview, with `assistant` chosen (default: the preferred one). */
  aiOpen(threadId: string, assistant?: string): void;
  aiScope(threadId: string, scope: ContextScope): void;
  aiAssistant(threadId: string, assistant: string): void;
  aiSend(threadId: string): void;
  aiCancel(threadId: string): void;
  /**
   * Ends the Ask AI session. With `discardQuestion`, the comment that opened it
   * (an @mention not yet answered) is deleted too; it can be restored from Deleted comments.
   */
  aiClose(threadId: string, discardQuestion?: boolean): void;
  /** Adds the (possibly edited) draft to the thread as an attributed AI message. */
  aiAdopt(threadId: string, body: string): Promise<boolean>;
  setFilter(filter: ThreadFilter): void;
  rerender(): void;
}

const isSubmit = (e: KeyboardEvent) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);

const SEARCH_KEY = 'search';
/** A tab count, capped so the tabs keep their width. */
export const countLabel = (n: number) => (n > 99 ? '99+' : String(n));
const FILTERS: { value: ThreadFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

export class ThreadPanel extends ItemView {
  private state: PanelState = {
    status: 'loading',
    notePath: null,
    noteName: '',
    views: [],
    pendingQuote: null,
    pendingImagePath: null,
    problems: [],
    focusedThreadId: null,
    filter: 'open',
    assistants: [],
    ai: {},
  };
  /** Search text is local to the panel; typing never touches storage. */
  private query = '';
  private custom: CommentFilters = { ...EMPTY_COMMENT_FILTERS };
  private customOpen = false;
  private pendingAiFocus: string | null = null;
  /** Set when a new thread was just posted: its reply box takes focus once it appears. */
  private replyAfterCreate = false;
  /** Set when the last render centered an Ask AI box, so the update does not scroll elsewhere. */
  private aiCentered = false;
  /** Open rows of each Ask AI preview tree, as `<threadId>:<row>`. */
  private readonly expanded = new Set<string>();
  /** Submit handlers of the visible comment boxes, for Cmd/Ctrl+Enter. */
  private readonly submitters = new WeakMap<HTMLElement, () => void>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly actions: PanelActions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_THREADGLYPH;
  }

  getDisplayText(): string {
    return 'Threadglyph';
  }

  getIcon(): string {
    return 'message-square-text';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('tg-panel');
    // While the panel has focus, Cmd/Ctrl+F searches threads instead of the note.
    this.scope = new Scope(this.app.scope);
    this.scope.register(['Mod'], 'f', () => {
      this.focusSearch();
      return false;
    });
    // Cmd/Ctrl+Shift+Right/Left step through comments; inside a text box they keep selecting text.
    this.scope.register(['Mod', 'Shift'], 'ArrowRight', () => this.stepCard(1));
    this.scope.register(['Mod', 'Shift'], 'ArrowLeft', () => this.stepCard(-1));
    // Claimed here so Obsidian's editor shortcuts (Cmd+Enter toggles a checkbox in the
    // note, which stays the active editor) never swallow them while the panel has focus.
    this.scope.register(['Mod'], 'Enter', () => this.submitFocused());
    // Cmd/Ctrl+D deletes the focused comment (from the reply box, the latest one);
    // Cmd/Ctrl+Shift+D deletes the whole thread, from anywhere in its card.
    this.scope.register(['Mod'], 'd', () => this.deleteFocused());
    this.scope.register(['Mod', 'Shift'], 'd', () => this.deleteFocusedThread());
    this.scope.register(['Mod', 'Shift'], 'Backspace', () => this.deleteFocused());
    this.scope.register(['Mod', 'Shift'], 'Delete', () => this.deleteFocused());
    this.render();
  }

  /**
   * Moves to the next or previous visible card (wrapping), focuses it and
   * highlights its passage. Returns false when handled, as Obsidian's Scope expects.
   */
  stepCard(direction: 1 | -1): boolean {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return true;
    const cards = [...this.contentEl.querySelectorAll<HTMLElement>('.tg-card[data-thread-id]')];
    if (!cards.length) return true;
    const current = active?.closest<HTMLElement>('.tg-card[data-thread-id]')
      ?? cards.find((c) => c.dataset.threadId === this.state.focusedThreadId);
    const index = current ? cards.indexOf(current) : -1;
    const next = index === -1
      ? cards[direction === 1 ? 0 : cards.length - 1]
      : cards[(index + direction + cards.length) % cards.length];
    next.focus({ preventScroll: true });
    this.center(next);
    void this.actions.select(next.dataset.threadId!);
    return false;
  }

  /** Cmd/Ctrl+Enter: submits the focused comment box, or sends the focused Ask AI preview. */
  submitFocused(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !this.contentEl.contains(active)) return true;
    const submit = this.submitters.get(active);
    if (submit) {
      submit();
      return false;
    }
    const send = active.closest('.tg-ai')?.querySelector<HTMLButtonElement>('button[data-draft-key^="ai-send:"]');
    if (!send) return true;
    send.click();
    return false;
  }

  /**
   * Cmd/Ctrl+D (or Cmd/Ctrl+Shift+Delete): asks to delete the focused comment,
   * or the card's latest one from anywhere else in the card, the reply box included.
   * Not while editing a comment, where the keys belong to the text.
   */
  deleteFocused(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !this.contentEl.contains(active) || active.instanceOf(HTMLInputElement)) return true;
    if (active.instanceOf(HTMLTextAreaElement) && !active.dataset.draftKey?.startsWith('reply:')) return true;
    const card = active.closest<HTMLElement>('.tg-card[data-thread-id]');
    const el = active.closest<HTMLElement>('.tg-message[data-message-id]') ?? [...(card?.querySelectorAll<HTMLElement>('.tg-message[data-message-id]') ?? [])].at(-1);
    const threadId = card?.dataset.threadId;
    const message = this.state.views.find((v) => v.thread.id === threadId)?.thread.messages.find((m) => m.id === el?.dataset.messageId);
    if (!threadId || !message) return true;
    this.confirmDelete(threadId, message);
    return false;
  }

  /** Cmd/Ctrl+Shift+D: asks to delete the whole thread whose card has focus. */
  deleteFocusedThread(): boolean {
    const active = document.activeElement as HTMLElement | null;
    const threadId = active && this.contentEl.contains(active)
      ? active.closest<HTMLElement>('.tg-card[data-thread-id]')?.dataset.threadId : undefined;
    const view = this.state.views.find((v) => v.thread.id === threadId);
    if (!view) return true;
    this.confirmDeleteThread(view);
    return false;
  }

  /** Puts the caret in the search box, selecting any existing query. */
  focusSearch(): void {
    const search = this.contentEl.querySelector<HTMLInputElement>('.tg-search');
    search?.focus();
    search?.select();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  update(state: PanelState): void {
    if (document.activeElement?.closest('.tg-panel') === this.contentEl) {
      const opened = Object.entries(state.ai).find(([id, ai]) => ai.state.phase === 'preview' && !this.state.ai[id]);
      if (opened) this.pendingAiFocus = `reply:${opened[0]}`;
    }
    const newComposer = state.pendingQuote !== null && this.state.pendingQuote === null;
    const newFocus = state.focusedThreadId !== this.state.focusedThreadId;
    this.state = state;
    this.aiCentered = false;
    this.render();
    // Used by the first update after posting (the new thread is already the focused one), then dropped.
    // Not when this update's render just put the keyboard in an Ask AI preview (aiCentered).
    const toReply = this.replyAfterCreate && !this.pendingAiFocus && !this.aiCentered && !!state.focusedThreadId;
    this.replyAfterCreate = false;
    if (newComposer) this.focusNewThread();
    else if (toReply) this.scrollToThread(state.focusedThreadId!, true);
    // An opened Ask AI box was already centered on its Send button; centering the whole card would push it away.
    else if (newFocus && state.focusedThreadId && !this.aiCentered) this.scrollToThread(state.focusedThreadId, false);
  }

  /**
   * Brings a thread's card into view. A search that hides the card is cleared.
   * Focus moves into the card's composer only when the user asked to reply.
   */
  scrollToThread(threadId: string, focusComposer = true): void {
    const find = () => this.contentEl.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`);
    if (!find() && (this.query || hasCommentFilters(this.custom))) {
      this.query = '';
      this.custom = { ...EMPTY_COMMENT_FILTERS };
      this.render();
    }
    const card = find();
    if (focusComposer) card?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    if (card) this.center(card);
  }

  focusNewThread(): void {
    const input = this.contentEl.querySelector<HTMLTextAreaElement>('.tg-card-new textarea');
    input?.focus({ preventScroll: true });
    const card = input?.closest<HTMLElement>('.tg-card-new');
    if (card) this.center(card);
  }

  /** Re-renders while keeping focus and caret in whichever draft the user was typing. */
  private render(): void {
    const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    const focusKey = active?.closest('.tg-panel') ? active.dataset.draftKey : undefined;
    const caret: [number | null, number | null] | null = focusKey &&
      (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
      ? [active.selectionStart, active.selectionEnd] : null;

    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    root.empty();
    this.renderHeader(root);

    if (this.state.status === 'loading') {
      root.createDiv({ cls: 'tg-empty', text: 'Loading threads…' });
    } else if (this.state.status === 'no-note') {
      root.createDiv({ cls: 'tg-empty', text: 'Open a note to see its threads.' });
    } else {
      this.renderBody(root);
    }

    root.scrollTop = scrollTop;
    this.restoreFocus(focusKey, caret);
  }

  private restoreFocus(focusKey: string | undefined, caret: [number | null, number | null] | null): void {
    const root = this.contentEl;
    if (focusKey) {
      const el = root.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-draft-key="${CSS.escape(focusKey)}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && (el.instanceOf(HTMLTextAreaElement) || (el.instanceOf(HTMLInputElement) && el.type === 'search'))) {
          el.setSelectionRange(caret[0], caret[1]);
        }
      }
    }
    this.focusAiPreview();
  }

  private focusAiPreview(): void {
    const root = this.contentEl;
    if (this.pendingAiFocus) {
      const id = this.pendingAiFocus.startsWith('reply:')
        ? this.pendingAiFocus.slice('reply:'.length) : this.state.focusedThreadId;
      const keys = [`ai-row:${id}:scope`, `ai-send:${id}`];
      const send = id ? keys.map((k) => [...root.querySelectorAll<HTMLElement>('[data-draft-key]')].find((el) => el.dataset.draftKey === k))
        .find((el) => el) : undefined;
      if (send) {
        send.focus({ preventScroll: true });
        this.center(send.closest<HTMLElement>('.tg-ai') ?? send);
        this.pendingAiFocus = null;
        this.aiCentered = true;
      }
    }
  }

  private center(target: HTMLElement): void {
    const root = this.contentEl;
    const box = target.getBoundingClientRect();
    const viewport = root.getBoundingClientRect();
    // Tall previews start at the top instead of hiding the question above the viewport.
    root.scrollTop += box.top - viewport.top - Math.max(12, (root.clientHeight - box.height) / 2);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: 'tg-header' });
    const title = header.createDiv({ cls: 'tg-header-title' });
    const glyph = title.createSpan({ cls: 'tg-header-glyph' });
    glyph.setAttr('aria-hidden', 'true');
    title.createSpan({ text: this.state.noteName || 'Threadglyph' });

    const open = this.state.views.filter((v) => v.thread.status === 'open').length;
    const resolved = this.state.views.length - open;
    if (this.state.status === 'ready') {
      const counts = resolved ? `${open} open · ${resolved} resolved` : `${open} open`;
      header.createDiv({ cls: 'tg-header-meta', text: counts });
      const detached = this.state.views.filter((v) => v.anchor.kind !== 'found' && v.thread.status === 'open').length;
      if (detached) header.createDiv({ cls: 'tg-header-warning', text: `${detached} thread${detached === 1 ? '' : 's'} lost ${detached === 1 ? 'its' : 'their'} passage and need${detached === 1 ? 's' : ''} reattaching (shown first).` });
    }
    if (this.state.status === 'ready') this.renderToolbar(header);
    this.renderDeleted(header);
    if (this.state.problems.length) {
      const warn = header.createDiv({ cls: 'tg-problem' });
      warn.setText(
        `${this.state.problems.length} Threadglyph file(s) could not be read and were left untouched: ` +
          this.state.problems.map((p) => `${p.path} (${p.error})`).join('; '),
      );
    }
  }

  private renderToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: 'tg-toolbar' });
    const search = bar.createEl('input', {
      cls: 'tg-search',
      attr: { type: 'search', placeholder: 'Search threads', 'aria-label': 'Search threads' },
    });
    search.dataset.draftKey = SEARCH_KEY;
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.render();
    };
    search.onkeydown = (e) => {
      if (e.key === 'Escape' && search.value) {
        e.preventDefault();
        this.query = '';
        this.render();
      }
    };

    const group = bar.createDiv({ cls: 'tg-filter', attr: { role: 'group', 'aria-label': 'Show threads' } });
    const open = this.state.views.filter((v) => v.thread.status === 'open').length;
    const counts: Record<ThreadFilter, number> = { open, resolved: this.state.views.length - open, all: this.state.views.length };
    for (const { value, label } of FILTERS) {
      const b = group.createEl('button', { cls: 'tg-filter-option', text: label });
      // Drawn by CSS, so the button's name stays "Open", "Resolved" or "All".
      b.dataset.count = countLabel(counts[value]);
      const selected = this.state.filter === value;
      b.setAttr('aria-pressed', String(selected));
      if (selected) b.addClass('is-active');
      b.onclick = () => this.actions.setFilter(value);
    }
    this.renderCustomFilters(bar);
  }

  private renderCustomFilters(bar: HTMLElement): void {
    const details = bar.createEl('details', { cls: 'tg-custom-filters' });
    details.open = this.customOpen;
    details.ontoggle = () => { this.customOpen = details.open; };
    details.createEl('summary', { text: hasCommentFilters(this.custom) ? 'Custom filters · active' : 'Custom filters' });
    const select = (label: string, value: string, options: [string, string][], change: (value: string) => void) => {
      const row = details.createEl('label', { cls: 'tg-custom-filter' });
      row.createSpan({ text: label });
      // A stable key brings focus back to the control after the panel re-renders.
      const input = row.createEl('select', { attr: { 'aria-label': label, 'data-draft-key': `filter:${label}` } });
      for (const [key, text] of options) input.createEl('option', { text, attr: { value: key } });
      input.value = value;
      input.onchange = () => { this.customOpen = true; change(input.value); this.render(); };
    };
    const agents = new Set(this.state.views.flatMap((v) => v.thread.messages
      .filter((m) => m.author.kind === 'ai').map((m) => m.author.name)));
    if (this.custom.agent) agents.add(this.custom.agent);
    select('Agent', this.custom.agent, [['', 'Any agent or person'], ...[...agents].sort((a, b) => a.localeCompare(b)).map((name): [string, string] => [name, name])],
      (value) => { this.custom.agent = value; });
    select('Comment age', String(this.custom.days), [['0', 'Any time'], ['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days']],
      (value) => { this.custom.days = Number(value); });
    for (const [key, label] of [['from', 'Comment from'], ['to', 'Comment through']] as const) {
      const row = details.createEl('label', { cls: 'tg-custom-filter' });
      row.createSpan({ text: label });
      const input = row.createEl('input', { attr: { type: 'date', 'aria-label': label, 'data-draft-key': `filter:${key}` } });
      input.value = this.custom[key];
      input.onchange = () => { this.customOpen = true; this.custom[key] = input.value; this.render(); };
    }
    details.createDiv({ cls: 'tg-filter-note', text: 'Matches when one comment meets all filters. Dates use your local time.' });
    const reset = details.createEl('button', { cls: 'tg-button', text: 'Clear custom filters' });
    reset.onclick = () => { this.custom = { ...EMPTY_COMMENT_FILTERS }; this.render(); };
  }

  private renderDeleted(root: HTMLElement): void {
    const deleted = this.state.deletedMessages ?? [];
    const threads = this.state.deletedThreads ?? [];
    if (!deleted.length && !threads.length) return;
    const details = root.createEl('details', { cls: 'tg-deleted' });
    details.createEl('summary', { text: `Deleted comments (${deleted.length + threads.length}) — Undo` });
    for (const { threadId, preview, count } of threads) {
      const row = details.createDiv();
      row.createSpan({ text: `Thread: ${previewQuote(preview)} (${count} comment${count === 1 ? '' : 's'})` });
      const undo = row.createEl('button', { text: 'Restore thread' });
      undo.onclick = () => { void this.actions.setThreadDeleted(threadId, false); };
    }
    for (const { threadId, message } of deleted) {
      const row = details.createDiv();
      row.createSpan({ text: previewQuote(message.body) });
      const undo = row.createEl('button', { text: 'Undo delete' });
      undo.onclick = () => { void this.actions.setMessageDeleted(threadId, message.id, false); };
    }
  }

  private renderBody(root: HTMLElement): void {
    const list = root.createDiv({ cls: 'tg-list' });
    if (this.state.pendingQuote !== null && this.state.notePath) this.renderNewThread(list, this.state.notePath);

    const shown = filterViews(this.state.views, this.state.filter, this.query, this.custom);
    if (!shown.length && this.state.pendingQuote === null) list.createDiv({ cls: 'tg-empty', text: this.emptyText() });
    for (const view of shown) this.renderThread(list, view);
  }

  private emptyText(): string {
    if (hasCommentFilters(this.custom)) return 'No threads match these filters. Clear custom filters or change the dates.';
    if (this.query.trim()) return `No threads match “${this.query.trim()}”.`;
    if (!this.state.views.length) {
      return 'No threads yet. Select text in the note, then run “Threadglyph: Comment on selection”.';
    }
    if (this.state.filter === 'open') return 'No open threads. Choose Resolved or All to see the rest.';
    return 'No resolved threads.';
  }

  /**
   * Arrow keys move between cards and Enter jumps to the passage, when the card or
   * one of its comments has focus (never while typing).
   */
  private onCardKey(e: KeyboardEvent, card: HTMLElement, threadId: string): void {
    // Escape ends a request before its answer (preview, running) or closes an error. A
    // reply that could not be saved is the only copy of the answer, so Escape leaves it
    // (and a save in progress) alone.
    const phase = this.state.ai[threadId]?.state.phase;
    if (e.key === 'Escape' && (phase === 'preview' || phase === 'running' || phase === 'error')) {
      this.exitAi(threadId);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target = e.target as HTMLElement;
    if (target !== card && !target.classList.contains('tg-message')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.actions.goTo(threadId);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const cards = [...this.contentEl.querySelectorAll<HTMLElement>('.tg-card[data-thread-id]')];
      const next = cards[cards.indexOf(card) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  }

  private renderNewThread(list: HTMLElement, notePath: string): void {
    const card = list.createDiv({ cls: 'tg-card tg-card-new' });
    card.createDiv({ cls: 'tg-card-label', text: 'New thread' });
    if (this.state.pendingImagePath) this.renderImage(card, this.state.pendingImagePath, null);
    else card.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(this.state.pendingQuote ?? '') });
    const key = draftKey.newThread(notePath);
    this.composer(card, key, 'Write a comment…', 'Comment', async (body) => this.actions.createThread(body), () =>
      this.actions.cancelNewThread(),
    );
  }

  private renderThread(list: HTMLElement, view: ThreadView): void {
    const { thread } = view;
    const card = list.createDiv({ cls: 'tg-card' });
    card.dataset.threadId = thread.id;
    // Lets a re-render keep keyboard focus on this card (panel navigation).
    card.dataset.draftKey = `card:${thread.id}`;
    card.setAttr('tabindex', '0');
    // Named by a hidden label: an aria-label would also show as a hover tooltip in Obsidian.
    const name = card.createSpan({ cls: 'tg-sr-only', text: `Thread ${view.number}${thread.status === 'resolved' ? ', resolved' : ''}` });
    name.id = `tg-thread-${thread.id}`;
    card.setAttr('aria-labelledby', name.id);
    card.onkeydown = (e) => this.onCardKey(e, card, thread.id);
    if (thread.status === 'resolved') card.addClass('tg-card-resolved');
    if (thread.id === this.state.focusedThreadId) card.addClass('tg-card-focused');

    const quoteRow = card.createDiv({ cls: 'tg-quote-row' });
    const badge = quoteRow.createSpan({ cls: 'tg-badge tg-card-number', text: String(view.number) });
    badge.setAttr('aria-hidden', 'true');
    if (view.imagePath !== null) {
      this.renderImage(quoteRow, view.imagePath, view.anchor.kind === 'found' ? () => void this.actions.goTo(thread.id) : null);
    } else if (view.quote !== null && view.anchor.kind === 'found') {
      const quote = quoteRow.createEl('button', { cls: 'tg-quote tg-quote-link', text: previewQuote(view.quote) });
      quote.setAttr('aria-label', 'Show this passage in the note');
      quote.onclick = () => void this.actions.goTo(thread.id);
    } else if (view.quote !== null) {
      quoteRow.createEl('blockquote', { cls: 'tg-quote tg-quote-stale', text: previewQuote(view.quote) });
    }

    const problem = anchorProblem(view.anchor, view.imagePath !== null);
    if (problem) {
      const warn = card.createDiv({ cls: 'tg-anchor-problem' });
      warn.createSpan({ text: problem });
      const reattach = warn.createEl('button', { cls: 'tg-link', text: 'Reattach to selection' });
      reattach.onclick = () => void this.actions.reattach(thread.id);
    }

    const messages = card.createDiv({ cls: 'tg-messages' });
    for (const message of thread.messages) this.renderMessage(messages, thread.id, message);

    if (thread.status === 'open') {
      this.composer(card, draftKey.reply(thread.id), 'Reply…', 'Reply', async (body) =>
        this.actions.reply(thread.id, body),
      );
    }

    const ai = this.state.ai[thread.id];
    if (ai) this.renderAi(card, thread.id, ai);

    const footer = card.createDiv({ cls: 'tg-card-footer' });
    if (this.state.assistants.length && thread.status === 'open' && !ai) {
      const ask = footer.createEl('button', { cls: 'tg-link tg-ask', text: 'Ask AI' });
      ask.onclick = () => this.actions.aiOpen(thread.id);
    }
    const toggle = footer.createEl('button', {
      cls: 'tg-link',
      text: thread.status === 'open' ? 'Resolve' : 'Reopen',
    });
    toggle.onclick = () => void this.actions.setResolved(thread.id, thread.status === 'open');
    const removeThread = footer.createEl('button', { cls: 'tg-link tg-delete-thread', text: 'Delete thread', attr: { title: 'Delete the whole thread (⌘⇧D)' } });
    removeThread.onclick = () => this.confirmDeleteThread(view);
  }

  /**
   * What the preview will send, as a small tree: "What to send", "Model" (with
   * several assistants) and "Exact text" start collapsed, so Enter sends the
   * defaults. Arrow keys open a row and move through its options; moving onto
   * an option chooses it.
   */
  private renderPreviewTree(box: HTMLElement, threadId: string, ai: AiCardView): void {
    const tree = box.createDiv({ cls: 'tg-ai-tree', attr: { role: 'tree', 'aria-label': 'Request options' } });
    const group = (id: string, label: string, summary: string, render: (body: HTMLElement) => void) => {
      const key = `${threadId}:${id}`;
      const open = this.expanded.has(key);
      const head = tree.createEl('button', { cls: 'tg-ai-row tg-ai-group', attr: { role: 'treeitem', 'aria-expanded': String(open) } });
      head.dataset.draftKey = `ai-row:${key}`;
      head.dataset.row = id;
      head.createSpan({ cls: 'tg-ai-caret', text: open ? '▾' : '▸' });
      head.createSpan({ cls: 'tg-ai-group-label', text: label });
      head.createSpan({ cls: 'tg-ai-group-summary', text: summary });
      head.onclick = () => this.toggleRow(key, !open);
      if (open) render(tree.createDiv({ cls: 'tg-ai-group-body', attr: { role: 'group' } }));
    };

    const scope = ai.scopes.find((s) => s.scope === ai.state.scope);
    group('scope', 'What to send', scope?.label ?? '', (body) => {
      const list = body.createEl('ul', { cls: 'tg-ai-items' });
      for (const item of ai.items) list.createEl('li', { text: item });
      const scopes = body.createDiv({ cls: 'tg-ai-scopes', attr: { role: 'radiogroup', 'aria-label': 'How much of the note to include' } });
      for (const option of ai.scopes) {
        const label = scopes.createEl('label', { cls: 'tg-ai-scope' });
        const radio = label.createEl('input', { cls: 'tg-ai-row', attr: { type: 'radio', name: `tg-scope-${threadId}`, value: option.scope } });
        radio.dataset.draftKey = `ai-row:${threadId}:scope:${option.scope}`;
        radio.checked = ai.state.scope === option.scope;
        radio.onchange = () => this.actions.aiScope(threadId, option.scope);
        label.createSpan({ text: option.label });
      }
      body.createDiv({ cls: 'tg-ai-note', text: 'Counts include instructions, context and thread text; image bytes and provider formatting are separate.' });
    });

    if (this.state.assistants.length > 1) {
      const current = this.state.assistants.find((a) => a.id === ai.state.assistant);
      group('model', 'Model', current ? `${current.name} · ${current.detail} · ${current.destination}` : '', (body) => {
        const picker = body.createDiv({ cls: 'tg-ai-assistants', attr: { role: 'radiogroup', 'aria-label': 'Assistant' } });
        for (const a of this.state.assistants) {
          // A class instead of `:has(input:checked)` in CSS; the panel re-renders when the choice changes.
          const label = picker.createEl('label', { cls: a.id === ai.state.assistant ? 'tg-ai-assistant is-selected' : 'tg-ai-assistant' });
          const radio = label.createEl('input', { cls: 'tg-ai-row', attr: { type: 'radio', name: `tg-assistant-${threadId}`, value: a.id } });
          radio.dataset.draftKey = `ai-row:${threadId}:model:${a.id}`;
          radio.checked = a.id === ai.state.assistant;
          radio.onchange = () => this.actions.aiAssistant(threadId, a.id);
          label.createSpan({ cls: 'tg-ai-assistant-name', text: a.name });
          label.createSpan({ cls: 'tg-ai-assistant-detail', text: `${a.detail} · ${a.destination}` });
        }
      });
    }

    group('exact', 'Exact text', `${[...ai.exactText].length.toLocaleString('en-US')} characters`, (body) => {
      body.createDiv({ cls: 'tg-ai-exact' }).createEl('pre', { text: ai.exactText });
    });
  }

  private toggleRow(key: string, open: boolean): void {
    if (open) this.expanded.add(key);
    else this.expanded.delete(key);
    this.render();
    this.contentEl.querySelector<HTMLElement>(`[data-draft-key="${CSS.escape(`ai-row:${key}`)}"]`)?.focus({ preventScroll: true });
  }

  /** Up/Down move through the tree's rows and Send; Right opens a row, Left closes it or goes back to it. */
  private onTreeKey(e: KeyboardEvent, box: HTMLElement, threadId: string): boolean {
    const target = e.target as HTMLElement;
    const rows = [...box.querySelectorAll<HTMLElement>('.tg-ai-row, button[data-draft-key^="ai-send:"]')];
    const at = rows.indexOf(target);
    const header = (el: HTMLElement) => el.classList.contains('tg-ai-group');
    const parentOf = (el: HTMLElement) => el.closest('.tg-ai-group-body')?.previousElementSibling as HTMLElement | null;
    let next: HTMLElement | null | undefined = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      next = rows[at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    } else if (e.key === 'ArrowRight' && header(target)) {
      if (target.getAttribute('aria-expanded') !== 'true') {
        this.toggleRow(`${threadId}:${target.dataset.row}`, true);
        return true;
      }
      next = rows[at + 1];
    } else if (e.key === 'ArrowLeft') {
      if (header(target) && target.getAttribute('aria-expanded') === 'true') {
        this.toggleRow(`${threadId}:${target.dataset.row}`, false);
        return true;
      }
      next = parentOf(target);
    } else {
      return false;
    }
    if (next && next !== target) {
      next.focus({ preventScroll: true });
      this.center(next);
      // Moving onto an option chooses it, as in a radio group.
      if (next.instanceOf(HTMLInputElement) && next.type === 'radio' && !next.checked) {
        next.checked = true;
        next.dispatchEvent(new Event('change'));
      }
    }
    return true;
  }

  /** Escape or Cancel before an answer: ends the request and discards the comment that asked it. */
  private exitAi(threadId: string): void {
    (document.activeElement as HTMLElement | null)?.blur();
    const phase = this.state.ai[threadId]?.state.phase;
    this.actions.aiClose(threadId, phase === 'preview' || phase === 'running');
    void this.actions.goTo(threadId);
  }

  private bindPreviewSend(box: HTMLElement, send: HTMLButtonElement, threadId: string, canSend: boolean): void {
    send.disabled = !canSend;
    send.dataset.draftKey = `ai-send:${threadId}`;
    send.setAttr('aria-label', 'Send request (Enter)');
    let sent = false;
    const sendOnce = () => {
      if (sent || send.disabled) return;
      sent = true;
      send.disabled = true;
      this.actions.aiSend(threadId);
    };
    send.onclick = sendOnce;
    box.onkeydown = (e) => {
      if (e.isComposing) return;
      if (this.onTreeKey(e, box, threadId)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const other = e.target instanceof HTMLButtonElement && e.target !== send && !e.target.classList.contains('tg-ai-row');
      // Enter (or Cmd+Enter) sends with whatever is chosen, from anywhere in the preview.
      if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !other) {
        e.preventDefault();
        e.stopPropagation();
        sendOnce();
      }
    };
  }

  private renderAi(card: HTMLElement, threadId: string, ai: AiCardView): void {
    const assistant = this.state.assistants.find((a) => a.id === ai.state.assistant);
    const name = assistant?.name ?? 'AI';
    const box = card.createDiv({ cls: `tg-ai tg-ai-phase-${ai.state.phase}` });
    box.setAttr('aria-live', 'polite');
    const buttons = (parent: HTMLElement) => parent.createDiv({ cls: 'tg-composer-buttons' });
    const button = (parent: HTMLElement, text: string, onClick: () => void, cta = false) => {
      const b = parent.createEl('button', { cls: cta ? 'tg-button mod-cta' : 'tg-button', text });
      b.onclick = onClick;
      return b;
    };
    const retry = (parent: HTMLElement) => {
      if (ai.canSend) button(parent, 'Retry', () => this.actions.aiSend(threadId));
    };

    switch (ai.state.phase) {
      case 'preview': {
        box.createDiv({ cls: 'tg-ai-title', text: 'Ask AI' });
        const where = assistant ? ` ${assistant.destination}.` : '';
        if (ai.state.notice) box.createDiv({ cls: 'tg-ai-error', attr: { role: 'status' }, text: ai.state.notice });
        box.createDiv({ cls: 'tg-ai-note', text: `${name} will receive the items below.${where}` });
        box.createDiv({ cls: 'tg-ai-note tg-ai-keys', text: 'Enter sends · ↑↓ move · → opens · Esc cancels and removes the question' });
        this.renderPreviewTree(box, threadId, ai);
        const row = buttons(box);
        button(row, 'Cancel', () => this.exitAi(threadId));
        const send = button(row, 'Send', () => this.actions.aiSend(threadId), true);
        this.bindPreviewSend(box, send, threadId, ai.canSend);
        break;
      }
      case 'running': {
        box.createDiv({ cls: 'tg-ai-title', text: `Asking ${name}…` });
        button(buttons(box), 'Cancel', () => this.actions.aiCancel(threadId));
        break;
      }
      case 'saving': {
        box.createDiv({ cls: 'tg-ai-title', text: `Saving ${name}'s reply…` });
        break;
      }
      case 'draft': {
        box.createDiv({ cls: 'tg-ai-title', text: `${name} · reply could not be saved` });
        box.createDiv({ cls: 'tg-ai-note', text: 'Your answer is kept here. Add it to the thread to retry saving without asking the model again.' });
        const key = `ai:${threadId}`;
        const input = box.createEl('textarea', { cls: 'tg-input', attr: { rows: '4', 'aria-label': `${name}'s draft reply` } });
        input.dataset.draftKey = key;
        input.value = this.actions.drafts.get(key) ?? ai.state.text;
        input.oninput = () => this.actions.drafts.set(key, input.value);
        const original = ai.state.text;
        const row = buttons(box);
        button(row, 'Discard', () => {
          if (input.value.trim() !== original.trim() && !window.confirm('Discard your edits to this draft?')) return;
          this.actions.drafts.delete(key);
          this.actions.aiClose(threadId);
        });
        retry(row);
        let busy = false;
        const add = button(
          row,
          'Add to thread',
          () => {
            if (busy || !input.value.trim()) return;
            busy = true;
            add.disabled = true;
            void this.actions
              .aiAdopt(threadId, input.value)
              .then((ok) => {
                if (ok) this.actions.drafts.delete(key);
              })
              .finally(() => {
                busy = false;
                add.disabled = false;
                this.actions.rerender();
              });
          },
          true,
        );
        break;
      }
      case 'error': {
        box.createDiv({ cls: 'tg-ai-title', text: `${name} could not answer` });
        box.createDiv({ cls: 'tg-ai-error', text: ai.state.message });
        if (!ai.canSend) box.createDiv({ cls: 'tg-ai-note', text: 'No retries left for this request. Close it and ask again later.' });
        const row = buttons(box);
        button(row, 'Close', () => this.actions.aiClose(threadId));
        // A failure is often specific to one provider, so offer the others directly.
        for (const other of this.state.assistants) {
          if (other.id !== ai.state.assistant) button(row, `Ask ${other.name}`, () => this.actions.aiAssistant(threadId, other.id));
        }
        retry(row);
        break;
      }
    }
  }

  /**
   * @-mention suggestions for the assistant. Returns a key handler the composer
   * consults first, so arrows/Enter/Escape drive the menu only while it is open.
   */
  private attachMentions(input: HTMLTextAreaElement, wrap: HTMLElement): (e: KeyboardEvent) => boolean {
    const names = this.mentionables().map((a) => a.name);
    if (!names.length) return () => false;
    let menu: HTMLElement | null = null;
    let items: string[] = [];
    let index = 0;

    const close = () => {
      menu?.remove();
      menu = null;
      items = [];
    };
    const pick = (name: string) => {
      const caret = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, caret).replace(/@(\w*)$/, `@${name} `);
      input.value = before + input.value.slice(caret);
      input.setSelectionRange(before.length, before.length);
      close();
      input.dispatchEvent(new Event('input'));
    };
    const update = () => {
      const typed = /(?:^|\s)@(\w*)$/.exec(input.value.slice(0, input.selectionStart ?? input.value.length));
      items = typed ? names.filter((n) => n.toLowerCase().startsWith(typed[1].toLowerCase())) : [];
      if (!items.length) return close();
      index = Math.min(index, items.length - 1);
      menu ??= wrap.createDiv({ cls: 'tg-mention-menu', attr: { role: 'listbox', 'aria-label': 'Mention an assistant' } });
      menu.empty();
      items.forEach((name, i) => {
        const option = menu!.createDiv({ cls: 'tg-mention-option', text: `@${name}` });
        const info = this.mentionables().find((a) => a.name === name);
        if (info) option.createSpan({ cls: 'tg-mention-detail', text: info.detail });
        option.setAttr('role', 'option');
        option.setAttr('aria-selected', String(i === index));
        if (i === index) option.addClass('is-selected');
        option.onmousedown = (e) => {
          e.preventDefault();
          pick(name);
        };
      });
    };
    input.addEventListener('input', update);
    input.addEventListener('blur', close);

    return (e) => {
      if (!menu) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        update();
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        pick(items[index]);
      } else if (e.key === 'Escape') {
        close();
      } else {
        return false;
      }
      e.preventDefault();
      return true;
    };
  }

  /** Image preview; a missing or unreadable file is named instead of shown. */
  private renderImage(parent: HTMLElement, path: string, onOpen: (() => void) | null): void {
    const name = path.split('/').pop() ?? path;
    const figure = parent.createEl(onOpen ? 'button' : 'div', { cls: 'tg-image' });
    if (onOpen) {
      figure.addClass('tg-quote-link');
      figure.setAttr('aria-label', `Show ${name} in the note`);
      figure.onclick = onOpen;
    }
    const src = this.actions.imageSrc(path);
    if (src) {
      const img = figure.createEl('img', { attr: { src, alt: `Image: ${name}`, loading: 'lazy' } });
      img.onerror = () => {
        img.remove();
        figure.createDiv({ cls: 'tg-image-missing', text: `${name} could not be displayed. The file may be damaged.` });
      };
    } else {
      figure.createDiv({ cls: 'tg-image-missing', text: `Image file not found: ${path}` });
    }
    figure.createDiv({ cls: 'tg-image-name', text: name });
  }

  private confirmDeleteThread(view: ThreadView): void {
    const count = view.thread.messages.length;
    new ConfirmDeleteModal(this.app, view.thread.messages[0]?.body ?? '', () => this.actions.setThreadDeleted(view.thread.id, true),
      `Delete this whole thread (${count} comment${count === 1 ? '' : 's'})?`).open();
  }

  private confirmDelete(threadId: string, message: Message): void {
    new ConfirmDeleteModal(this.app, message.body, () => this.actions.setMessageDeleted(threadId, message.id, true)).open();
  }

  /**
   * One comment: who and when, the text, then small Edit / Delete links under it.
   * The comment itself takes keyboard focus (Tab moves comment to comment); the
   * links are left out of the Tab order, with E and Cmd/Ctrl+D doing the same.
   */
  private renderMessage(parent: HTMLElement, threadId: string, message: Message): void {
    const el = parent.createDiv({ cls: `tg-message tg-message-${message.author.kind}` });
    el.tabIndex = 0;
    el.dataset.messageId = message.id;
    el.dataset.draftKey = `message:${message.id}`;
    el.setAttr('role', 'article');
    el.onclick = (e) => {
      if (!(e.target as HTMLElement).closest('button, textarea, input')) el.focus({ preventScroll: true });
    };
    const meta = el.createDiv({ cls: 'tg-message-meta' });
    meta.createSpan({ cls: 'tg-author', text: message.author.name });
    const origin = originLabel(message);
    if (origin) meta.createSpan({ cls: 'tg-origin', text: origin });
    // The original time stays; an edit only adds "edited", with its time on hover.
    meta.createSpan({ cls: 'tg-time', text: formatTimestamp(message.createdAt) });
    if (message.editedAt) {
      const edited = meta.createSpan({ cls: 'tg-edited', text: 'edited' });
      edited.setAttr('title', `Edited ${formatTimestamp(message.editedAt)}`);
    }

    const key = draftKey.edit(threadId, message.id);
    if (this.actions.editing.has(key)) {
      if (!this.actions.drafts.has(key)) this.actions.drafts.set(key, message.body);
      this.composer(
        el,
        key,
        'Edit message…',
        'Save',
        async (body) => {
          const saved = await this.actions.saveEdit(threadId, message.id, body);
          if (saved) this.actions.editing.delete(key);
          return saved;
        },
        () => {
          this.actions.cancelEdit(threadId, message.id);
        },
        message.body,
      );
      return;
    }

    // Plain text only: comment and model text are never interpreted as HTML.
    el.createDiv({ cls: 'tg-message-body', text: message.body });
    const startEdit = () => {
      this.actions.startEdit(threadId, message.id);
      this.contentEl.querySelector<HTMLTextAreaElement>(`textarea[data-draft-key="${CSS.escape(key)}"]`)?.focus();
    };
    const actions = el.createDiv({ cls: 'tg-message-actions' });
    const edit = actions.createEl('button', { cls: 'tg-message-action', text: 'Edit', attr: { tabindex: '-1', title: 'Edit (E)' } });
    edit.onclick = startEdit;
    const remove = actions.createEl('button', { cls: 'tg-message-action', text: 'Delete', attr: { tabindex: '-1', title: 'Delete comment (⌘D)' } });
    remove.onclick = () => this.confirmDelete(threadId, message);
    el.onkeydown = (e) => {
      if (e.target !== el || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        startEdit();
      }
    };
  }

  private hasAssistantMention(body: string): boolean {
    const mentions = new Set([...body.matchAll(/(?:^|\s)@(\w+)\b/g)].map((m) => m[1].toLowerCase()));
    return this.mentionables().some((a) => mentions.has(a.name.toLowerCase()));
  }

  /** Everything the @ menu offers: each enabled assistant. */
  private mentionables(): AssistantInfo[] {
    return this.state.assistants;
  }

  /**
   * A textarea bound to a persistent draft. Cmd/Ctrl+Enter submits, Escape cancels.
   * Cancelling a changed draft asks before discarding it.
   */
  private composer(
    parent: HTMLElement,
    key: string,
    placeholder: string,
    submitLabel: string,
    submit: (body: string) => Promise<boolean>,
    cancel?: () => void,
    initial = '',
  ): void {
    const wrap = parent.createDiv({ cls: 'tg-composer' });
    const input = wrap.createEl('textarea', { cls: 'tg-input', attr: { placeholder, rows: '2' } });
    input.dataset.draftKey = key;
    input.setAttr('aria-label', placeholder.replace('…', ''));
    input.value = this.actions.drafts.get(key) ?? '';
    input.oninput = () => this.actions.drafts.set(key, input.value);

    const buttons = wrap.createDiv({ cls: 'tg-composer-buttons' });
    // Ignore repeat clicks or Cmd/Ctrl+Enter while a submit is in flight, so one action writes once.
    let busy = false;
    const doSubmit = async () => {
      const body = input.value;
      if (busy || !body.trim()) return;
      const mentions = !key.startsWith('edit:') && this.hasAssistantMention(body);
      if (mentions) this.pendingAiFocus = key;
      busy = true;
      submitButton.disabled = true;
      // The box is read-only while it saves, so nothing typed meanwhile can be lost.
      input.readOnly = true;
      try {
        if (await submit(body)) {
          // Clear the draft only if it is still what was posted.
          if ((this.actions.drafts.get(key) ?? body) === body) this.actions.drafts.delete(key);
          // A new thread continues in its reply box.
          if (key.startsWith('new:')) this.replyAfterCreate = true;
          if (mentions) this.pendingAiFocus = key;
        } else this.pendingAiFocus = null;
      } finally {
        busy = false;
        submitButton.disabled = false;
        input.readOnly = false;
      }
      this.actions.rerender();
    };
    const doCancel = cancel
      ? () => {
          const draft = this.actions.drafts.get(key) ?? '';
          if (draft.trim() && draft !== initial && !window.confirm('Discard your unsaved text?')) return;
          this.actions.drafts.delete(key);
          cancel();
        }
      : null;

    if (doCancel) {
      const cancelButton = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel', attr: { tabindex: '-1', title: 'Cancel (Esc)' } });
      cancelButton.onclick = doCancel;
    }
    // Out of the Tab order: Cmd/Ctrl+Enter submits, so Tab moves on to the next comment or card.
    const submitButton = buttons.createEl('button', { cls: 'tg-button mod-cta', text: submitLabel, attr: { tabindex: '-1', title: `${submitLabel} (⌘↩)` } });
    submitButton.onclick = () => void doSubmit();

    const mentionKey = this.attachMentions(input, wrap);
    this.submitters.set(input, () => void doSubmit());
    input.onkeydown = (e) => {
      if (e.isComposing || e.repeat) return;
      // Enter always makes a new line in a comment box; Cmd/Ctrl+Enter submits.
      if (mentionKey(e)) return;
      if (isSubmit(e)) {
        e.preventDefault();
        void doSubmit();
      } else if (e.key === 'Escape' && doCancel) {
        e.preventDefault();
        doCancel();
      }
    };
  }
}
