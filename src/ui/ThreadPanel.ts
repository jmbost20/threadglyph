import { ItemView, Scope, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { AiState, ContextScope } from '../ai/session';
import type { Message } from '../model/types';
import type { LoadProblem } from '../storage/threadStore';
import {
  anchorProblem,
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
  setResolved(threadId: string, resolved: boolean): Promise<void>;
  reattach(threadId: string): Promise<void>;
  goTo(threadId: string): Promise<void>;
  /** A displayable URL for a vault image, or null when the file is missing. */
  imageSrc(path: string): string | null;
  /** Opens the Ask AI preview, with `assistant` chosen (default: the preferred one). */
  aiOpen(threadId: string, assistant?: string): void;
  aiScope(threadId: string, scope: ContextScope): void;
  aiAssistant(threadId: string, assistant: string): void;
  aiSend(threadId: string): void;
  aiCancel(threadId: string): void;
  aiClose(threadId: string): void;
  /** Adds the (possibly edited) draft to the thread as an attributed AI message. */
  aiAdopt(threadId: string, body: string): Promise<boolean>;
  setFilter(filter: ThreadFilter): void;
  rerender(): void;
}

const isSubmit = (e: KeyboardEvent) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);

const SEARCH_KEY = 'search';
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
    this.render();
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
    this.state = state;
    this.render();
  }

  /**
   * Brings a thread's card into view. A search that hides the card is cleared.
   * Focus moves into the card's composer only when the user asked to reply.
   */
  scrollToThread(threadId: string, focusComposer = true): void {
    const find = () => this.contentEl.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`);
    if (!find() && this.query) {
      this.query = '';
      this.render();
    }
    const card = find();
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (focusComposer) card?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }

  focusNewThread(): void {
    const input = this.contentEl.querySelector<HTMLTextAreaElement>('.tg-card-new textarea');
    input?.scrollIntoView({ block: 'nearest' });
    input?.focus();
  }

  /** Re-renders while keeping focus and caret in whichever draft the user was typing. */
  private render(): void {
    const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    const focusKey = active?.closest('.tg-panel') ? active.dataset.draftKey : undefined;
    const caret = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;

    const root = this.contentEl;
    root.empty();
    this.renderHeader(root);

    if (this.state.status === 'loading') {
      root.createDiv({ cls: 'tg-empty', text: 'Loading threads…' });
    } else if (this.state.status === 'no-note') {
      root.createDiv({ cls: 'tg-empty', text: 'Open a note to see its threads.' });
    } else {
      this.renderBody(root);
    }

    if (focusKey) {
      const el = root.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-draft-key="${CSS.escape(focusKey)}"]`);
      if (el) {
        el.focus();
        if (caret) el.setSelectionRange(caret[0], caret[1]);
      }
    }
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
    }
    if (this.state.status === 'ready') this.renderToolbar(header);
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
    for (const { value, label } of FILTERS) {
      const b = group.createEl('button', { cls: 'tg-filter-option', text: label });
      const selected = this.state.filter === value;
      b.setAttr('aria-pressed', String(selected));
      if (selected) b.addClass('is-active');
      b.onclick = () => this.actions.setFilter(value);
    }
  }

  private renderBody(root: HTMLElement): void {
    const list = root.createDiv({ cls: 'tg-list' });
    if (this.state.pendingQuote !== null && this.state.notePath) this.renderNewThread(list, this.state.notePath);

    const shown = filterViews(this.state.views, this.state.filter, this.query);
    if (!shown.length && this.state.pendingQuote === null) list.createDiv({ cls: 'tg-empty', text: this.emptyText() });
    for (const view of shown) this.renderThread(list, view);
  }

  private emptyText(): string {
    if (this.query.trim()) return `No threads match “${this.query.trim()}”.`;
    if (!this.state.views.length) {
      return 'No threads yet. Select text in the note, then run “Threadglyph: Comment on selection”.';
    }
    if (this.state.filter === 'open') return 'No open threads. Choose Resolved or All to see the rest.';
    return 'No resolved threads.';
  }

  /** Arrow keys move between cards and Enter jumps to the passage, only when the card itself has focus. */
  private onCardKey(e: KeyboardEvent, card: HTMLElement, threadId: string): void {
    if (e.target !== card) return;
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
    card.setAttr('tabindex', '0');
    card.setAttr('aria-label', `Thread ${view.number}${thread.status === 'resolved' ? ', resolved' : ''}`);
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
  }

  /** Radio buttons for choosing the assistant, each with its model and where the request goes. */
  private renderAssistantPicker(box: HTMLElement, threadId: string, current: string): void {
    const group = box.createDiv({ cls: 'tg-ai-assistants', attr: { role: 'radiogroup', 'aria-label': 'Assistant' } });
    for (const a of this.state.assistants) {
      const label = group.createEl('label', { cls: 'tg-ai-assistant' });
      const radio = label.createEl('input', { attr: { type: 'radio', name: `tg-assistant-${threadId}`, value: a.id } });
      radio.checked = a.id === current;
      radio.onchange = () => this.actions.aiAssistant(threadId, a.id);
      label.createSpan({ cls: 'tg-ai-assistant-name', text: a.name });
      label.createSpan({ cls: 'tg-ai-assistant-detail', text: `${a.detail} · ${a.destination}` });
    }
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
        if (this.state.assistants.length > 1) this.renderAssistantPicker(box, threadId, ai.state.assistant);
        const where = assistant ? ` ${assistant.destination}.` : '';
        box.createDiv({ cls: 'tg-ai-note', text: `${name} will receive the items below.${where}` });
        const list = box.createEl('ul', { cls: 'tg-ai-items' });
        for (const item of ai.items) list.createEl('li', { text: item });
        const scopes = box.createDiv({ cls: 'tg-ai-scopes', attr: { role: 'radiogroup', 'aria-label': 'How much of the note to include' } });
        for (const option of ai.scopes) {
          const label = scopes.createEl('label', { cls: 'tg-ai-scope' });
          const radio = label.createEl('input', { attr: { type: 'radio', name: `tg-scope-${threadId}`, value: option.scope } });
          radio.checked = ai.state.scope === option.scope;
          radio.onchange = () => this.actions.aiScope(threadId, option.scope);
          label.createSpan({ text: option.label });
        }
        const details = box.createEl('details', { cls: 'tg-ai-exact' });
        details.createEl('summary', { text: 'Show exact text' });
        details.createEl('pre', { text: ai.exactText });
        const row = buttons(box);
        button(row, 'Cancel', () => this.actions.aiClose(threadId));
        const send = button(row, 'Send', () => this.actions.aiSend(threadId), true);
        send.disabled = !ai.canSend;
        break;
      }
      case 'running': {
        box.createDiv({ cls: 'tg-ai-title', text: `Asking ${name}…` });
        button(buttons(box), 'Cancel', () => this.actions.aiCancel(threadId));
        break;
      }
      case 'draft': {
        box.createDiv({ cls: 'tg-ai-title', text: `${name} · draft, not in the thread yet` });
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
    const names = this.state.assistants.map((a) => a.name);
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
        const info = this.state.assistants.find((a) => a.name === name);
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
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey) {
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

  private renderMessage(parent: HTMLElement, threadId: string, message: Message): void {
    const el = parent.createDiv({ cls: `tg-message tg-message-${message.author.kind}` });
    const meta = el.createDiv({ cls: 'tg-message-meta' });
    meta.createSpan({ cls: 'tg-author', text: message.author.name });
    const origin = originLabel(message);
    if (origin) meta.createSpan({ cls: 'tg-origin', text: origin });
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
    const edit = meta.createEl('button', { cls: 'tg-icon-button' });
    setIcon(edit, 'pencil');
    edit.setAttr('aria-label', `Edit message from ${message.author.name}`);
    edit.onclick = () => {
      this.actions.startEdit(threadId, message.id);
      this.contentEl.querySelector<HTMLTextAreaElement>(`textarea[data-draft-key="${CSS.escape(key)}"]`)?.focus();
    };
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
      if (busy || !input.value.trim()) return;
      busy = true;
      submitButton.disabled = true;
      try {
        if (await submit(input.value)) this.actions.drafts.delete(key);
      } finally {
        busy = false;
        submitButton.disabled = false;
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
      const cancelButton = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
      cancelButton.onclick = doCancel;
    }
    const submitButton = buttons.createEl('button', { cls: 'tg-button mod-cta', text: submitLabel });
    submitButton.onclick = () => void doSubmit();

    const mentionKey = this.attachMentions(input, wrap);
    input.onkeydown = (e) => {
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
