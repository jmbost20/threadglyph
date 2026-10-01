import { Modal, type App } from 'obsidian';
import type { DiffLine } from '../agent/diff';
import type { ImportItem } from '../import/agentComments';
import { previewQuote } from './viewModel';

const STATUS_TEXT: Record<ImportItem['status'], string> = {
  new: 'Will be imported',
  'already-imported': 'Already imported',
  'nothing-to-import': 'Nothing to import (reactions or status only)',
};

/** Read-only preview of an Agent Comments import; nothing is written until Import is pressed. */
export class ImportModal extends Modal {
  constructor(
    app: App,
    private readonly noteName: string,
    private readonly items: ImportItem[],
    private readonly onImport: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const fresh = this.items.filter((i) => i.status === 'new').length;
    this.titleEl.setText('Import Agent Comments');
    contentEl.addClass('tg-modal');
    contentEl.createEl('p', {
      text:
        `${this.items.length} Agent Comments thread(s) in “${this.noteName}”. Importing copies them into Threadglyph. ` +
        'The note is not changed, and its {==…==} markup stays in place. Opinion tags are not carried over.',
    });
    const list = contentEl.createEl('ul', { cls: 'tg-import-list' });
    for (const item of this.items) {
      const li = list.createEl('li', { cls: `tg-import-item tg-import-${item.status}` });
      li.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(item.legacy.quote) });
      const facts = [`${item.messages} message${item.messages === 1 ? '' : 's'}`];
      if (item.legacy.resolved) facts.push('resolved');
      facts.push(STATUS_TEXT[item.status]);
      li.createDiv({ cls: 'tg-import-meta', text: facts.join(' · ') });
    }
    const buttons = contentEl.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
    cancel.onclick = () => this.close();
    const run = buttons.createEl('button', { cls: 'tg-button mod-cta', text: fresh ? `Import ${fresh}` : 'Nothing new to import' });
    run.disabled = fresh === 0;
    run.onclick = async () => {
      run.disabled = true;
      await this.onImport();
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Lists backups in the vault's local exports folder; choosing one restores what is missing. */
export class RestoreModal extends Modal {
  constructor(
    app: App,
    private readonly files: string[],
    private readonly onPick: (path: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Restore threads from a backup');
    contentEl.addClass('tg-modal');
    if (!this.files.length) {
      contentEl.createEl('p', { text: 'No backups yet. Run “Threadglyph: Back up all threads” first.' });
      return;
    }
    contentEl.createEl('p', {
      text: 'Adds threads from the backup that are missing here. Existing threads are never overwritten.',
    });
    const list = contentEl.createDiv({ cls: 'tg-restore-list' });
    // Newest first: names embed an ISO timestamp.
    for (const path of [...this.files].sort((a, b) => b.localeCompare(a))) {
      const b = list.createEl('button', { cls: 'tg-button tg-restore-file', text: path.split('/').pop() ?? path });
      b.onclick = async () => {
        await this.onPick(path);
        this.close();
      };
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Asks before a comment is deleted. Delete has focus, so Enter confirms and Escape cancels. */
export class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly body: string,
    private readonly onConfirm: () => Promise<unknown>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Delete this comment?');
    contentEl.addClass('tg-modal');
    contentEl.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(this.body) });
    contentEl.createEl('p', { text: 'You can bring it back later from “Deleted comments” at the top of the panel.' });
    const buttons = contentEl.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
    cancel.onclick = () => this.close();
    const remove = buttons.createEl('button', { cls: 'tg-button mod-warning', text: 'Delete' });
    remove.onclick = async () => {
      remove.disabled = true;
      await this.onConfirm();
      this.close();
    };
    remove.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface ReadPermission {
  search: string | null;
  notes: { name: string; path: string | null; daily: boolean }[];
  /** e.g. "Stays on this computer" or "Sent to Google". */
  destination: string;
  cloud: boolean;
}

/**
 * Asks before the agent reads other notes. Closing the dialog any way other
 * than Allow counts as Deny, and Deny has focus, so Enter or Escape declines.
 */
export class ReadPermissionModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly ask: ReadPermission,
    private readonly onDecide: (allowed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Let the agent read other notes?');
    contentEl.addClass('tg-modal');
    const list = contentEl.createEl('ul', { cls: 'tg-read-list' });
    if (this.ask.search) {
      list.createEl('li', { text: `Search your notes for “${this.ask.search}” (up to 3 matches; daily notes are skipped)` });
    }
    for (const note of this.ask.notes) {
      const li = list.createEl('li', { text: note.path ?? `${note.name} (not found, will be skipped)` });
      if (note.daily) li.createSpan({ cls: 'tg-read-daily', text: ' · daily note' });
    }
    contentEl.createEl('p', {
      cls: this.ask.cloud ? 'tg-ai-error' : 'tg-ai-note',
      text: this.ask.cloud
        ? `${this.ask.destination}: the text of these notes will leave this computer.`
        : `${this.ask.destination}.`,
    });
    const buttons = contentEl.createDiv({ cls: 'tg-composer-buttons' });
    const deny = buttons.createEl('button', { cls: 'tg-button', text: 'Deny' });
    deny.onclick = () => this.decide(false);
    const allow = buttons.createEl('button', { cls: 'tg-button mod-cta', text: 'Allow' });
    allow.onclick = () => this.decide(true);
    deny.focus();
  }

  private decide(allowed: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecide(allowed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide(false);
  }
}

/** Asks before an agent request goes to a cloud assistant. Cancel has focus. */
export class ConfirmSendModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly what: string,
    private readonly destination: string,
    private readonly onDecide: (send: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Send to a cloud assistant?');
    contentEl.addClass('tg-modal');
    contentEl.createEl('p', { text: `${this.what} will be sent. ${this.destination}.` });
    contentEl.createEl('p', { cls: 'tg-ai-note', text: 'To keep it on this computer, choose Local as the preferred assistant in settings.' });
    const buttons = contentEl.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
    cancel.onclick = () => this.decide(false);
    const send = buttons.createEl('button', { cls: 'tg-button mod-cta', text: 'Send' });
    send.onclick = () => this.decide(true);
    cancel.focus();
  }

  private decide(send: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecide(send);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide(false);
  }
}

/** One row of a side-by-side comparison; either side may be empty. */
export interface CompareRow {
  before: string | null;
  after: string | null;
  kind: 'same' | 'change';
}

/**
 * Pairs a line diff into side-by-side rows: unchanged lines face each other,
 * and a run of removed lines faces the run of added lines that replaced it.
 */
export function compareRows(diff: DiffLine[]): CompareRow[] {
  const rows: CompareRow[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ before: removed[i] ?? null, after: added[i] ?? null, kind: 'change' });
    }
    removed = [];
    added = [];
  };
  for (const line of diff) {
    if (line.kind === 'remove') removed.push(line.text);
    else if (line.kind === 'add') added.push(line.text);
    else {
      flush();
      rows.push({ before: line.text, after: line.text, kind: 'same' });
    }
  }
  flush();
  return rows;
}

/** The original and the proposed text side by side, changed lines facing each other. */
export function renderCompare(parent: HTMLElement, diff: DiffLine[]): HTMLElement {
  const grid = parent.createDiv({ cls: 'tg-compare' });
  grid.createDiv({ cls: 'tg-compare-head', text: 'Original' });
  grid.createDiv({ cls: 'tg-compare-head', text: 'Proposed' });
  for (const row of compareRows(diff)) {
    const side = (text: string | null, which: 'before' | 'after') => {
      const cell = grid.createDiv({ cls: `tg-compare-cell tg-compare-${which}` });
      if (row.kind === 'change') cell.addClass(text === null ? 'tg-compare-empty' : which === 'before' ? 'tg-compare-removed' : 'tg-compare-added');
      cell.setText(text ?? '');
    };
    side(row.before, 'before');
    side(row.after, 'after');
  }
  return grid;
}

/** The original and the proposed text side by side, with changed lines marked. */
export class CompareModal extends Modal {
  constructor(
    app: App,
    private readonly diff: DiffLine[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText('Original vs. proposed');
    contentEl.addClass('tg-modal', 'tg-compare-modal');
    (this as unknown as { modalEl?: HTMLElement }).modalEl?.addClass('tg-compare-wide');
    renderCompare(contentEl, this.diff);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
