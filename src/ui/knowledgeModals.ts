import { Modal, type App } from 'obsidian';
import type { ReviewDecision } from '../knowledge/coordinator';
import type { KnowledgeJob, KnowledgeStatusView } from '../knowledge/types';
import { previewQuote } from './viewModel';

/**
 * The review form for a knowledge request that may duplicate an existing
 * object: add it to one of the matches, or make a new object (title and essence
 * editable). Enter or ⌘↩ applies the selected choice.
 */
export class KnowledgeReviewModal extends Modal {
  private choice: string;
  private title: string;
  private essence: string;

  constructor(
    app: App,
    private readonly job: KnowledgeJob,
    private readonly onDecide: (decision: ReviewDecision) => Promise<void>,
    private readonly onCancelRequest: () => Promise<void>,
  ) {
    super(app);
    const proposal = job.proposal!;
    this.choice = job.candidates?.[0]?.path ?? 'new';
    this.title = proposal.title;
    this.essence = proposal.essence;
  }

  onOpen(): void {
    const { contentEl } = this;
    const proposal = this.job.proposal!;
    this.titleEl.setText('Review knowledge');
    contentEl.addClass('tg-modal', 'tg-knowledge-review');
    if (this.job.quote) contentEl.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(this.job.quote) });
    contentEl.createDiv({ cls: 'tg-ai-note', text: `Request: ${this.job.request}` });
    contentEl.createEl('p', { text: this.job.reason ?? 'This may already be in your knowledge.' });

    const options = contentEl.createEl('fieldset', { cls: 'tg-ask-scopes' });
    options.createEl('legend', { text: 'Where should it go?' });
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
    radio('new', 'Create a new object', proposal.essence);

    const fields = contentEl.createDiv({ cls: 'tg-review-new' });
    fields.toggleClass('is-hidden', this.choice !== 'new');
    const title = fields.createEl('input', { cls: 'tg-input', attr: { type: 'text', 'aria-label': 'Title' } });
    title.value = this.title;
    title.oninput = () => {
      this.title = title.value;
    };
    const essence = fields.createEl('textarea', { cls: 'tg-input', attr: { rows: '4', 'aria-label': 'Essence' } });
    essence.value = this.essence;
    essence.oninput = () => {
      this.essence = essence.value;
    };

    const buttons = contentEl.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel request' });
    cancel.onclick = async () => {
      await this.onCancelRequest();
      this.close();
    };
    const later = buttons.createEl('button', { cls: 'tg-button', text: 'Later' });
    later.onclick = () => this.close();
    const apply = buttons.createEl('button', { cls: 'tg-button mod-cta', text: 'Apply (⌘↩)' });
    const doApply = async () => {
      if (apply.disabled) return;
      apply.disabled = true;
      await this.onDecide(this.choice === 'new' ? { kind: 'new', title: this.title, essence: this.essence } : { kind: 'existing', path: this.choice });
      this.close();
    };
    apply.onclick = doApply;
    this.scope.register(['Mod'], 'Enter', () => {
      void doApply();
      return false;
    });
    apply.focus();
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
      open(path: string): void;
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
      if (view.objectPath) {
        const path = view.objectPath;
        button('Open', () => this.act.open(path));
      }
      if (job.state === 'needs-review') button('Review', () => {
        this.close();
        this.act.review(job.id);
      });
      if (job.state === 'failed' || job.state === 'waiting-anki') button(job.state === 'failed' ? 'Retry' : 'Check again', () => this.act.retry(job.id));
      if (['queued', 'running', 'needs-review', 'waiting-anki'].includes(job.state)) button('Cancel', () => this.act.cancel(job.id));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
