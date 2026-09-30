import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { renderProposal, type ProposalView } from './proposalView';

export const VIEW_TYPE_AGENT = 'threadglyph-agent';

export interface ChatTurn {
  role: 'you' | 'agent' | 'note';
  text: string;
  /** Key of the proposal this answer made, if any. */
  proposalKey?: string;
}

export interface ChatState {
  noteName: string | null;
  /** What a request would change right now, e.g. "The section “Groceries” (240 characters)". */
  target: string | null;
  /** Which assistant answers and where the request goes. */
  via: string | null;
  turns: ChatTurn[];
  running: boolean;
  proposals: Record<string, ProposalView>;
}

export interface ChatActions {
  send(text: string): void;
  cancel(): void;
  clear(): void;
  accept(key: string): void;
  reject(key: string): void;
}

/**
 * A chat with the agent about the active note. The conversation lives only in
 * memory, since it holds note text; nothing in the note changes until Accept.
 */
export class AgentView extends ItemView {
  private state: ChatState = { noteName: null, target: null, via: null, turns: [], running: false, proposals: {} };
  private draft = '';

  constructor(
    leaf: WorkspaceLeaf,
    private readonly actions: ChatActions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_AGENT;
  }

  getDisplayText(): string {
    return 'Threadglyph agent';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('tg-panel', 'tg-chat');
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  update(state: ChatState): void {
    this.state = state;
    this.render();
  }

  focusInput(): void {
    this.contentEl.querySelector<HTMLTextAreaElement>('.tg-chat-input')?.focus();
  }

  private render(): void {
    const root = this.contentEl;
    const hadFocus = document.activeElement?.classList.contains('tg-chat-input') ?? false;
    root.empty();
    const header = root.createDiv({ cls: 'tg-header' });
    header.createDiv({ cls: 'tg-header-title', text: this.state.noteName ? `Agent · ${this.state.noteName}` : 'Agent' });
    if (this.state.turns.length) {
      const clear = header.createEl('button', { cls: 'tg-link', text: 'Clear chat' });
      clear.onclick = () => this.actions.clear();
    }

    const log = root.createDiv({ cls: 'tg-chat-log', attr: { 'aria-live': 'polite' } });
    if (!this.state.turns.length) {
      log.createDiv({
        cls: 'tg-empty',
        text: 'Ask the agent to change this note, e.g. “sort these tasks” or “add a list of next steps”. ' +
          'Select text first to limit what it may change. You see every change before it happens.',
      });
    }
    for (const turn of this.state.turns) {
      const el = log.createDiv({ cls: `tg-message tg-chat-${turn.role}` });
      el.createDiv({ cls: 'tg-message-body', text: turn.text });
      const proposal = turn.proposalKey ? this.state.proposals[turn.proposalKey] : undefined;
      if (proposal) {
        renderProposal(el, proposal, () => this.actions.accept(proposal.key), () => this.actions.reject(proposal.key));
      }
    }
    if (this.state.running) log.createDiv({ cls: 'tg-ai-title', text: 'Asking the agent…' });

    const composer = root.createDiv({ cls: 'tg-composer' });
    if (this.state.target) composer.createDiv({ cls: 'tg-ai-note', text: `May change: ${this.state.target}` });
    if (this.state.via) composer.createDiv({ cls: 'tg-ai-note', text: this.state.via });
    const input = composer.createEl('textarea', {
      cls: 'tg-input tg-chat-input',
      attr: { rows: '3', placeholder: this.state.noteName ? 'What should the agent do?' : 'Open a note first', 'aria-label': 'Message the agent' },
    });
    input.value = this.draft;
    input.disabled = !this.state.noteName;
    input.oninput = () => {
      this.draft = input.value;
    };
    const buttons = composer.createDiv({ cls: 'tg-composer-buttons' });
    const submit = () => {
      if (this.state.running || !input.value.trim()) return;
      const text = input.value.trim();
      this.draft = '';
      input.value = '';
      this.actions.send(text);
    };
    if (this.state.running) {
      const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
      cancel.onclick = () => this.actions.cancel();
    }
    const send = buttons.createEl('button', { cls: 'tg-button mod-cta', text: 'Send' });
    send.disabled = this.state.running || !this.state.noteName;
    send.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
    if (hadFocus) input.focus();
    log.scrollTop = log.scrollHeight;
  }
}
