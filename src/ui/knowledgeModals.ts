import { Modal, type App } from 'obsidian';
import type { ReviewDecision } from '../knowledge/coordinator';
import { CARD_TYPE_LABELS, CARD_TYPES, type CardPlan, type CardType, type KnowledgeJob, type KnowledgeStatusView } from '../knowledge/types';
import { previewQuote } from './viewModel';

/**
 * One form for a knowledge request that needs the owner: where the concept goes
 * (an existing object or a new one, name and essence editable) and, for a card
 * request, what cards to write (type, roughly how many, a note). It opens by
 * itself when a request needs it; Enter or ⌘↩ applies.
 */
export class KnowledgeReviewModal extends Modal {
  private choice: string;
  private title: string;
  private essence: string;
  private plan: CardPlan;

  constructor(
    app: App,
    private readonly job: KnowledgeJob,
    private readonly onDecide: (decision: ReviewDecision, plan?: CardPlan) => Promise<void>,
    private readonly onCancelRequest: () => Promise<void>,
  ) {
    super(app);
    const proposal = job.proposal!;
    this.choice = job.suggest ?? job.candidates?.[0]?.path ?? 'new';
    this.title = proposal.title;
    this.essence = proposal.essence;
    this.plan = { type: proposal.cardType ?? 'concept', count: proposal.cardCount ?? 1, note: '' };
  }

  private get cards(): boolean {
    return this.job.action === 'card';
  }

  onOpen(): void {
    const { contentEl } = this;
    const proposal = this.job.proposal!;
    this.titleEl.setText(this.cards ? `New cards · ${proposal.title}` : 'Review knowledge');
    contentEl.addClass('tg-modal', 'tg-knowledge-review');
    const source = this.job.excerpt || this.job.quote;
    if (source) contentEl.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(source.replace(/\*\*/g, '')) });
    contentEl.createDiv({ cls: 'tg-ai-note', text: `Request: ${this.job.request}` });
    if (this.job.state === 'needs-review' || this.job.candidates?.length) {
      contentEl.createEl('p', { text: this.job.reason ?? 'This may already be in your knowledge.' });
    }

    const options = contentEl.createEl('fieldset', { cls: 'tg-ask-scopes' });
    options.createEl('legend', { text: 'Concept' });
    const radio = (value: string, label: string, detail: string) => {
      const row = options.createEl('label', { cls: 'tg-ask-scope tg-review-option' });
      const input = row.createEl('input', { attr: { type: 'radio', name: 'tg-review', value } });
      input.checked = this.choice === value;
      input.onchange = () => {
        this.choice = value;
        fields.toggleClass('is-hidden', value !== 'new');
      };
      const text = row.createDiv();
      text.createDiv({ cls: 'tg-review-title', text: label });
      if (detail) text.createDiv({ cls: 'tg-review-detail', text: previewQuote(detail) });
    };
    for (const c of this.job.candidates ?? []) radio(c.path, `Add to “${c.title}”`, c.essence);
    radio('new', 'New concept', '');

    const fields = options.createDiv({ cls: 'tg-review-new' });
    fields.toggleClass('is-hidden', this.choice !== 'new');
    const title = fields.createEl('input', { cls: 'tg-input', attr: { type: 'text', 'aria-label': 'Concept name' } });
    title.value = this.title;
    title.oninput = () => {
      this.title = title.value;
    };
    const essence = fields.createEl('textarea', { cls: 'tg-input', attr: { rows: '3', 'aria-label': 'Essence' } });
    essence.value = this.essence;
    essence.oninput = () => {
      this.essence = essence.value;
    };

    if (this.cards) this.renderCardChoices(contentEl, proposal.ambiguous);

    const buttons = contentEl.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel request' });
    cancel.onclick = async () => {
      await this.onCancelRequest();
      this.close();
    };
    const later = buttons.createEl('button', { cls: 'tg-button', text: 'Later' });
    later.onclick = () => this.close();
    const apply = buttons.createEl('button', { cls: 'tg-button mod-cta', text: this.cards ? 'Create cards (↩)' : 'Apply (↩)' });
    const doApply = async () => {
      if (apply.disabled) return;
      apply.disabled = true;
      const decision: ReviewDecision = this.choice === 'new' ? { kind: 'new', title: this.title, essence: this.essence } : { kind: 'existing', path: this.choice };
      await this.onDecide(decision, this.cards ? this.plan : undefined);
      this.close();
    };
    apply.onclick = doApply;
    const run = (e?: KeyboardEvent) => {
      // Enter in the essence or note box is a new line; ⌘↩ applies from anywhere.
      if (e && !e.metaKey && !e.ctrlKey && (e.target as HTMLElement | null)?.tagName === 'TEXTAREA') return true;
      void doApply();
      return false;
    };
    this.scope.register([], 'Enter', run);
    this.scope.register(['Mod'], 'Enter', run);
    apply.focus();
  }

  private renderCardChoices(el: HTMLElement, ambiguous: boolean): void {
    const box = el.createEl('fieldset', { cls: 'tg-ask-scopes tg-card-choices' });
    box.createEl('legend', { text: 'Cards' });
    if (ambiguous) box.createDiv({ cls: 'tg-ai-caution', text: 'Not sure what you want to learn here. Is this a concept card?' });
    const type = box.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Card type' } });
    for (const t of CARD_TYPES) {
      const option = type.createEl('option', { text: CARD_TYPE_LABELS[t], attr: { value: t } });
      option.selected = t === this.plan.type;
    }
    type.onchange = () => {
      this.plan = { ...this.plan, type: type.value as CardType };
    };
    const counts = box.createDiv({ cls: 'tg-card-counts', attr: { role: 'radiogroup', 'aria-label': 'Roughly how many cards' } });
    counts.createSpan({ cls: 'tg-review-detail', text: 'Roughly how many:' });
    for (const n of [1, 2, 3, 5, 8]) {
      const label = counts.createEl('label', { cls: 'tg-card-count' });
      const input = label.createEl('input', { attr: { type: 'radio', name: 'tg-card-count', value: String(n) } });
      input.checked = this.plan.count === n || (n === 8 && this.plan.count > 5) || (n === 5 && this.plan.count === 4);
      input.onchange = () => {
        this.plan = { ...this.plan, count: n };
      };
      label.createSpan({ text: n === 8 ? '6+' : String(n) });
    }
    const note = box.createEl('textarea', { cls: 'tg-input', attr: { rows: '2', 'aria-label': 'Anything else', placeholder: 'Anything else? e.g. “contrast it with a cache miss”' } });
    note.oninput = () => {
      this.plan = { ...this.plan, note: note.value };
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface QueueRow {
  job: KnowledgeJob;
  view: KnowledgeStatusView;
  noteName: string;
}

/** Every knowledge job, newest first, with what can be done for each. */
export class KnowledgeQueueModal extends Modal {
  constructor(
    app: App,
    private readonly rows: () => QueueRow[],
    private readonly act: {
      /** Shows the job's concept and cards in the knowledge base. */
      open(jobId: string): void;
      review(jobId: string): void;
      retry(jobId: string): Promise<void>;
      cancel(jobId: string): Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Knowledge queue');
    this.contentEl.addClass('tg-modal', 'tg-knowledge-queue');
    this.render();
  }

  render(): void {
    const el = this.contentEl;
    el.empty();
    const rows = this.rows();
    if (!rows.length) {
      el.createEl('p', { text: 'No knowledge requests yet. Write @knowledge or @card in a comment to make one.' });
      return;
    }
    for (const { job, view, noteName } of [...rows].reverse()) {
      const row = el.createDiv({ cls: `tg-knowledge-row is-${job.state}` });
      row.createSpan({ cls: 'tg-knowledge-kind', text: job.action === 'card' ? 'Card' : 'Knowledge' });
      const text = row.createDiv({ cls: 'tg-knowledge-text' });
      text.createDiv({ text: view.text });
      text.createDiv({ cls: 'tg-review-detail', text: `${noteName} · ${previewQuote(job.request)}` });
      const button = (label: string, run: () => void | Promise<void>) => {
        const b = row.createEl('button', { cls: 'tg-link tg-knowledge-action', text: label });
        b.onclick = async () => {
          await run();
          this.render();
        };
      };
      if (view.objectPath) button('Open', () => this.act.open(job.id));
      if (job.state === 'needs-review' || job.state === 'needs-intake') button('Review', () => {
        this.close();
        this.act.review(job.id);
      });
      if (job.state === 'failed' || job.state === 'waiting-anki') button(job.state === 'failed' ? 'Retry' : 'Check again', () => this.act.retry(job.id));
      if (['queued', 'running', 'needs-review', 'needs-intake', 'waiting-anki'].includes(job.state)) button('Cancel', () => this.act.cancel(job.id));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
