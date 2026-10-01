import { Modal, type App } from 'obsidian';
import type { ContextScope } from '../ai/session';
import { renderCompare } from './modals';
import { renderDiff, type ProposalView } from './proposalView';

/** One choice of what the agent may change, e.g. "This list item and everything under it (240 characters)". */
export interface AskScope {
  scope: ContextScope;
  label: string;
}

export interface AskOutcome {
  /** The agent's answer, or why there is none. */
  text: string;
  /** Its proposal, when it proposed a change. */
  proposal: ProposalView | null;
}

export interface AskSetup {
  noteName: string;
  /** Who answers and where the text goes, e.g. "Answered by Local (qwen3:8b) · stays on this computer". */
  via: string;
  scopes: AskScope[];
  scope: ContextScope;
  run(instruction: string, scope: ContextScope, signal: AbortSignal): Promise<AskOutcome>;
  accept(key: string): Promise<boolean>;
  reject(key: string): void;
}

type Phase = 'ask' | 'running' | 'result';

/**
 * The window @agent opens in a note: what should the agent do, then its
 * proposed change as a diff. Nothing changes in the note until Accept; a
 * proposal left open here also waits under the text in the note.
 */
export class AgentAskModal extends Modal {
  private phase: Phase = 'ask';
  private instruction = '';
  private target: ContextScope;
  private outcome: AskOutcome | null = null;
  private sideBySide = false;
  private run: AbortController | null = null;
  private primary: (() => void) | null = null;

  constructor(
    app: App,
    private readonly setup: AskSetup,
  ) {
    super(app);
    this.target = setup.scope;
  }

  onOpen(): void {
    this.titleEl.setText(`Ask the agent · ${this.setup.noteName}`);
    this.contentEl.addClass('tg-modal', 'tg-ask-modal');
    (this as unknown as { modalEl?: HTMLElement }).modalEl?.addClass('tg-ask-wide');
    // Cmd/Ctrl+Enter sends the request, then accepts the proposal; Enter is a new line.
    this.scope.register(['Mod'], 'Enter', () => {
      this.primary?.();
      return false;
    });
    this.render();
  }

  onClose(): void {
    // Closing while it runs cancels the request; an open proposal stays in the note.
    this.run?.abort();
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    this.primary = null;
    if (this.phase === 'ask') this.renderAsk(el);
    else if (this.phase === 'running') this.renderRunning(el);
    else this.renderResult(el);
  }

  private renderAsk(el: HTMLElement): void {
    const input = el.createEl('textarea', {
      cls: 'tg-input tg-ask-input',
      attr: { rows: '3', placeholder: 'What should the agent do? e.g. “sort these”, “add a list of next steps”', 'aria-label': 'What should the agent do?' },
    });
    input.value = this.instruction;
    input.oninput = () => {
      this.instruction = input.value;
    };
    const scopes = el.createEl('fieldset', { cls: 'tg-ask-scopes' });
    scopes.createEl('legend', { text: 'It may change' });
    for (const option of this.setup.scopes) {
      const label = scopes.createEl('label', { cls: 'tg-ask-scope' });
      const radio = label.createEl('input', { attr: { type: 'radio', name: 'tg-ask-scope', value: option.scope } });
      radio.checked = option.scope === this.target;
      radio.onchange = () => {
        this.target = option.scope;
      };
      label.createSpan({ text: option.label });
    }
    el.createDiv({ cls: 'tg-ai-note', text: `${this.setup.via}. Nothing in the note changes until you Accept.` });
    const buttons = el.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
    cancel.onclick = () => this.close();
    const send = buttons.createEl('button', { cls: 'tg-button mod-cta', text: 'Ask (⌘↩)' });
    const submit = () => {
      if (!this.instruction.trim()) {
        input.focus();
        return;
      }
      void this.ask();
    };
    send.onclick = submit;
    this.primary = submit;
    input.focus();
  }

  private renderRunning(el: HTMLElement): void {
    el.createDiv({ cls: 'tg-ai-title', text: 'Asking the agent…' });
    el.createDiv({ cls: 'tg-ask-request', text: this.instruction.trim() });
    el.createDiv({ cls: 'tg-ai-note', text: 'A local model can take a minute or more on a long list.' });
    const buttons = el.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
    cancel.onclick = () => {
      this.run?.abort();
      this.phase = 'ask';
      this.render();
    };
  }

  private renderResult(el: HTMLElement): void {
    const outcome = this.outcome;
    if (!outcome) return;
    const proposal = outcome.proposal;
    el.createDiv({ cls: 'tg-ask-request', text: this.instruction.trim() });
    if (outcome.text) el.createDiv({ cls: 'tg-proposal-reply', text: outcome.text });
    const buttons = () => el.createDiv({ cls: 'tg-composer-buttons' });
    if (!proposal || proposal.error || !proposal.diff) {
      if (proposal?.error) el.createDiv({ cls: 'tg-ai-error', text: proposal.error });
      const row = buttons();
      const again = row.createEl('button', { cls: 'tg-button', text: 'Ask again' });
      again.onclick = () => {
        if (proposal) this.setup.reject(proposal.key);
        this.phase = 'ask';
        this.render();
      };
      const close = row.createEl('button', { cls: 'tg-button mod-cta', text: 'Close' });
      close.onclick = () => this.close();
      this.primary = () => this.close();
      return;
    }
    if (proposal.caution) el.createDiv({ cls: 'tg-ai-caution', text: proposal.caution });
    const tabs = el.createDiv({ cls: 'tg-ask-tabs', attr: { role: 'tablist' } });
    const tab = (text: string, side: boolean) => {
      const b = tabs.createEl('button', { cls: `tg-link${this.sideBySide === side ? ' is-active' : ''}`, text, attr: { role: 'tab', 'aria-selected': String(this.sideBySide === side) } });
      b.onclick = () => {
        this.sideBySide = side;
        this.render();
      };
    };
    tab('Changes', false);
    tab('Side by side', true);
    const body = el.createDiv({ cls: 'tg-ask-diff' });
    if (this.sideBySide) renderCompare(body, proposal.diff);
    else renderDiff(body, proposal.diff);
    el.createDiv({ cls: 'tg-ai-note', text: 'Accept applies it as one edit (⌘Z undoes it). Close to decide later: it waits under the text in the note.' });
    const row = buttons();
    const reject = row.createEl('button', { cls: 'tg-button', text: 'Reject' });
    reject.onclick = () => {
      this.setup.reject(proposal.key);
      this.close();
    };
    const accept = row.createEl('button', { cls: 'tg-button mod-cta', text: 'Accept (⌘↩)' });
    const doAccept = () => {
      accept.disabled = true;
      void this.setup.accept(proposal.key).then((ok) => {
        if (ok) this.close();
        else {
          this.outcome = { text: outcome.text, proposal: { ...proposal, error: 'The note changed since this preview. Nothing was changed; ask again.' } };
          this.render();
        }
      });
    };
    accept.onclick = doAccept;
    this.primary = doAccept;
    accept.focus();
  }

  private async ask(): Promise<void> {
    const run = new AbortController();
    this.run = run;
    this.phase = 'running';
    this.render();
    const outcome = await this.setup.run(this.instruction.trim(), this.target, run.signal);
    // Cancelled, or the window was closed: this answer is not wanted.
    if (run.signal.aborted || this.run !== run) {
      if (outcome.proposal) this.setup.reject(outcome.proposal.key);
      return;
    }
    this.run = null;
    this.outcome = outcome;
    this.phase = 'result';
    this.render();
  }
}
