import { Modal, type App } from 'obsidian';
import type { ImportItem } from '../import/inlineComments';
import { formatTimestamp, previewQuote } from './viewModel';

const STATUS_TEXT: Record<ImportItem['status'], string> = {
  new: 'Will be imported',
  'already-imported': 'Already imported',
  'nothing-to-import': 'Nothing to import (reactions or status only)',
};

/** Read-only preview of an inline comment import; nothing is written until Import is pressed. */
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
    this.titleEl.setText('Import inline comments');
    contentEl.addClass('tg-modal');
    contentEl.createEl('p', {
      text:
        `${this.items.length} inline comment thread(s) in “${this.noteName}”. Importing copies them into Threadglyph. ` +
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
    private readonly title = 'Delete this comment?',
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.title);
    contentEl.addClass('tg-modal');
    contentEl.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(this.body) });
    contentEl.createEl('p', { text: 'You can bring it back later from “Deleted comments” at the top of the panel.' });
    const buttons = contentEl.createDiv({ cls: 'tg-composer-buttons' });
    const cancel = buttons.createEl('button', { cls: 'tg-button', text: 'Cancel' });
    cancel.onclick = () => this.close();
    const remove = buttons.createEl('button', { cls: 'tg-button mod-warning', text: 'Delete' });
    const confirm = async () => {
      if (remove.disabled) return;
      remove.disabled = true;
      await this.onConfirm();
      this.close();
    };
    remove.onclick = confirm;
    // Enter deletes, wherever focus landed: Obsidian may move focus after open.
    this.scope.register([], 'Enter', () => {
      void confirm();
      return false;
    });
    remove.focus();
    window.setTimeout(() => remove.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** A thread whose note is not in the vault. */
export interface MissingNoteThread {
  threadId: string;
  notePath: string;
  /** The first remaining comment, or the first comment when all are deleted. */
  preview: string;
  /** Comments not deleted. */
  comments: number;
  updatedAt: string;
  /** Every comment is deleted; the thread can be restored. */
  deleted: boolean;
}

export interface MissingNoteActions {
  /** The threads to list, read again after every action. */
  list(): MissingNoteThread[];
  /** Name of the open note threads can be moved to, or null when none is open. */
  target: string | null;
  move(threadId: string): Promise<boolean>;
  setDeleted(threadId: string, deleted: boolean): Promise<boolean>;
}

/**
 * Lists threads whose note was deleted or renamed outside Obsidian, which no
 * panel can show. Each can be moved to the open note or deleted (and restored).
 */
export class MissingNotesModal extends Modal {
  constructor(
    app: App,
    private readonly actions: MissingNoteActions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Threads on missing notes');
    this.contentEl.addClass('tg-modal');
    this.render();
  }

  private render(): void {
    const { contentEl, actions } = this;
    contentEl.empty();
    const items = actions.list();
    if (!items.length) {
      contentEl.createEl('p', { text: 'Every thread’s note is in the vault.' });
      return;
    }
    contentEl.createEl('p', {
      text:
        'These threads belong to notes that were deleted, or renamed outside Obsidian. They come back on their own if the note returns. ' +
        (actions.target
          ? `You can also move one to the open note, “${actions.target}”, and reattach it there.`
          : 'Open a note first to move threads into it.'),
    });
    const list = contentEl.createEl('ul', { cls: 'tg-import-list' });
    for (const item of items) {
      const li = list.createEl('li', { cls: item.deleted ? 'tg-import-item tg-missing-deleted' : 'tg-import-item' });
      li.createDiv({ cls: 'tg-missing-path', text: item.notePath });
      li.createEl('blockquote', { cls: 'tg-quote', text: previewQuote(item.preview) });
      const facts = item.deleted
        ? ['Deleted']
        : [`${item.comments} comment${item.comments === 1 ? '' : 's'}`, `last activity ${formatTimestamp(item.updatedAt)}`];
      li.createDiv({ cls: 'tg-import-meta', text: facts.join(' · ') });
      const buttons = li.createDiv({ cls: 'tg-composer-buttons' });
      const button = (text: string, cls: string, run: () => Promise<boolean>) => {
        const b = buttons.createEl('button', { cls: `tg-button ${cls}`, text });
        b.onclick = async () => {
          b.disabled = true;
          await run();
          this.render();
        };
        return b;
      };
      if (item.deleted) {
        button('Restore', '', () => actions.setDeleted(item.threadId, false));
        continue;
      }
      button('Delete', 'mod-warning', () => actions.setDeleted(item.threadId, true));
      const move = button(actions.target ? `Move to “${actions.target}”` : 'Move to the open note', 'mod-cta', () => actions.move(item.threadId));
      move.disabled = actions.target === null;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
