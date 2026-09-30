import type { DiffLine } from '../agent/diff';

/** A proposal as the panel and the chat show it. */
export interface ProposalView {
  key: string;
  reply: string;
  diff: DiffLine[] | null;
  /** Why it cannot be applied (a mismatched edit, or the note changed). */
  error: string | null;
}

/** Unchanged lines further than this from a change fold into "…". */
const CONTEXT = 2;

/** Red/green line diff; long unchanged stretches are folded. */
export function renderDiff(parent: HTMLElement, diff: DiffLine[]): HTMLElement {
  const removed = diff.filter((d) => d.kind === 'remove').length;
  const added = diff.filter((d) => d.kind === 'add').length;
  parent.createDiv({ cls: 'tg-diff-summary', text: `${removed} line${removed === 1 ? '' : 's'} removed · ${added} added` });
  const box = parent.createDiv({ cls: 'tg-diff', attr: { role: 'group', 'aria-label': 'Proposed change' } });
  const near = diff.map((_, i) =>
    diff.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((d) => d.kind !== 'same'));
  let folded = false;
  diff.forEach((line, i) => {
    if (line.kind === 'same' && !near[i]) {
      if (!folded) box.createDiv({ cls: 'tg-diff-line tg-diff-fold', text: '…' });
      folded = true;
      return;
    }
    folded = false;
    const sign = { same: ' ', add: '+', remove: '−' }[line.kind];
    const row = box.createDiv({ cls: `tg-diff-line tg-diff-${line.kind}` });
    row.createSpan({ cls: 'tg-diff-sign', text: sign });
    row.createSpan({ text: line.text || ' ' });
    if (line.kind !== 'same') row.setAttr('aria-label', `${line.kind === 'add' ? 'Added' : 'Removed'}: ${line.text}`);
  });
  return box;
}

/** The reply, the diff and Accept / Reject (or Dismiss when it cannot be applied). */
export function renderProposal(
  parent: HTMLElement,
  view: ProposalView,
  onAccept: () => void,
  onReject: () => void,
  onCompare?: () => void,
): HTMLElement {
  const box = parent.createDiv({ cls: 'tg-proposal' });
  box.dataset.proposal = view.key;
  box.createDiv({ cls: 'tg-ai-title', text: view.error ? 'The agent’s change can’t be applied' : 'Proposed change' });
  if (view.reply) box.createDiv({ cls: 'tg-proposal-reply', text: view.reply });
  if (view.error) box.createDiv({ cls: 'tg-ai-error', text: view.error });
  else if (view.diff) {
    renderDiff(box, view.diff);
    box.createDiv({ cls: 'tg-ai-note', text: 'Nothing has changed yet. Accept applies it as one edit; ⌘Z undoes it.' });
  }
  const buttons = box.createDiv({ cls: 'tg-composer-buttons' });
  if (!view.error && view.diff && onCompare) {
    const compare = buttons.createEl('button', { cls: 'tg-button', text: 'Compare' });
    compare.setAttr('aria-label', 'Show the original and the proposed text side by side');
    compare.onclick = onCompare;
  }
  const reject = buttons.createEl('button', { cls: 'tg-button', text: view.error ? 'Dismiss' : 'Reject' });
  reject.onclick = onReject;
  if (!view.error) {
    const accept = buttons.createEl('button', { cls: 'tg-button mod-cta', text: 'Accept' });
    accept.onclick = () => {
      accept.disabled = true;
      onAccept();
    };
  }
  return box;
}
