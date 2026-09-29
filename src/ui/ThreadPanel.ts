import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { Message } from '../model/types';
import type { LoadProblem } from '../storage/threadStore';
import {
  anchorProblem,
  draftKey,
  formatTimestamp,
  originLabel,
  previewQuote,
  type ThreadView,
} from './viewModel';

export const VIEW_TYPE_THREADGLYPH = 'threadglyph-panel';

export interface PanelState {
  status: 'loading' | 'no-note' | 'ready';
  notePath: string | null;
  noteName: string;
  views: ThreadView[];
  pendingQuote: string | null;
  problems: LoadProblem[];
  focusedThreadId: string | null;
  showResolved: boolean;
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
  toggleShowResolved(): void;
  rerender(): void;
}

const isSubmit = (e: KeyboardEvent) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);

export class ThreadPanel extends ItemView {
  private state: PanelState = {
    status: 'loading',
    notePath: null,
    noteName: '',
    views: [],
    pendingQuote: null,
    problems: [],
    focusedThreadId: null,
    showResolved: false,
  };

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
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  update(state: PanelState): void {
    this.state = state;
    this.render();
  }

  scrollToThread(threadId: string): void {
    const card = this.contentEl.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }

  focusNewThread(): void {
    const input = this.contentEl.querySelector<HTMLTextAreaElement>('.tg-card-new textarea');
    input?.scrollIntoView({ block: 'nearest' });
    input?.focus();
  }

  /** Re-renders while keeping focus and caret in whichever draft the user was typing. */
  private render(): void {
    const active = document.activeElement as HTMLTextAreaElement | null;
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
      const el = root.querySelector<HTMLTextAreaElement>(`textarea[data-draft-key="${CSS.escape(focusKey)}"]`);
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
    if (this.state.problems.length) {
      const warn = header.createDiv({ cls: 'tg-problem' });
      warn.setText(
        `${this.state.problems.length} Threadglyph file(s) could not be read and were left untouched: ` +
          this.state.problems.map((p) => `${p.path} (${p.error})`).join('; '),
      );
    }
  }

  private renderBody(root: HTMLElement): void {
    const list = root.createDiv({ cls: 'tg-list' });
    if (this.state.pendingQuote !== null && this.state.notePath) this.renderNewThread(list, this.state.notePath);

    const open = this.state.views.filter((v) => v.thread.status === 'open');
    const resolved = this.state.views.filter((v) => v.thread.status === 'resolved');

    if (!open.length && this.state.pendingQuote === null) {
      list.createDiv({
        cls: 'tg-empty',
        text: 'No open threads. Select text in the note, then run “Threadglyph: Comment on selection”.',
      });
    }
    for (const view of open) this.renderThread(list, view);

    if (resolved.length) {
      const toggle = list.createEl('button', {
        cls: 'tg-link tg-resolved-toggle',
        text: this.state.showResolved ? `Hide resolved (${resolved.length})` : `Show resolved (${resolved.length})`,
      });
      toggle.setAttr('aria-expanded', String(this.state.showResolved));
      toggle.onclick = () => this.actions.toggleShowResolved();
      if (this.state.showResolved) for (const view of resolved) this.renderThread(list, view);
    }
  }

  private renderNewThread(list: HTMLElement, notePath: string): void {
    const card = list.createDiv({ cls: 'tg-card tg-card-new' });
    card.createDiv({ cls: 'tg-card-label', text: 'New thread' });
    card.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(this.state.pendingQuote ?? '') });
    const key = draftKey.newThread(notePath);
    this.composer(card, key, 'Write a comment…', 'Comment', async (body) => this.actions.createThread(body), () =>
      this.actions.cancelNewThread(),
    );
  }

  private renderThread(list: HTMLElement, view: ThreadView): void {
    const { thread } = view;
    const card = list.createDiv({ cls: 'tg-card' });
    card.dataset.threadId = thread.id;
    if (thread.status === 'resolved') card.addClass('tg-card-resolved');
    if (thread.id === this.state.focusedThreadId) card.addClass('tg-card-focused');

    const quoteRow = card.createDiv({ cls: 'tg-quote-row' });
    if (view.quote !== null && view.anchor.kind === 'found') {
      const quote = quoteRow.createEl('button', { cls: 'tg-quote tg-quote-link', text: previewQuote(view.quote) });
      quote.setAttr('aria-label', 'Show this passage in the note');
      quote.onclick = () => void this.actions.goTo(thread.id);
    } else if (view.quote !== null) {
      quoteRow.createEl('blockquote', { cls: 'tg-quote tg-quote-stale', text: previewQuote(view.quote) });
    }

    const problem = anchorProblem(view.anchor);
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

    const footer = card.createDiv({ cls: 'tg-card-footer' });
    const toggle = footer.createEl('button', {
      cls: 'tg-link',
      text: thread.status === 'open' ? 'Resolve' : 'Reopen',
    });
    toggle.onclick = () => void this.actions.setResolved(thread.id, thread.status === 'open');
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

    input.onkeydown = (e) => {
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
