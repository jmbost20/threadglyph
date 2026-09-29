import { Modal, type App } from 'obsidian';
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
    for (const path of [...this.files].sort().reverse()) {
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
