/** UAT: inline comment import, and backup and restore (docs/dev/pilot.md steps 7 and 8). */
import { rmSync } from 'node:fs';
import { DIR, WELCOME, inlineComments, cards, comment, open, threadFiles, welcome } from '../fixtures.mjs';

const SAMPLE = `${DIR}/Inline comments sample.md`;

export default {
  feature: 'Import and backup',
  summary: 'Inline comment threads come in read-only, and a backup restores only what is missing, never overwriting.',
  scenarios: [
    {
      name: 'Import inline comments without touching the note',
      weight: 'major',
      intro: {"headline": "This shows bringing in comments written as inline markup, without touching the note.", "context": "The sample note contains inline comment markup, with the comments stored inside the note’s text. Import reads them, previews the three threads it found, and creates ThreadGlyph threads beside the note. The note file stays byte-for-byte as it was, and running the import again finds nothing new."},
      tradeoffs: [{"option": "Copy into threads, leaving the markup in the note", "downside": "The comments now exist twice: the old markup stays in the note until you remove it.", "chosen": true}, {"option": "Move: import, then strip the markup from the note", "downside": "Tidy, but it edits your note, and a bad import would lose the originals."}, {"option": "Read the markup live, without importing", "downside": "No duplicates, but replies made in ThreadGlyph would have nowhere to go."}],
      summary: 'Pilot step 7: the preview lists 3 threads; importing them leaves the note byte-for-byte unchanged; a second import finds nothing new.',
      fixtures: { [SAMPLE]: inlineComments },
      async run(s) {
        await s.step('Open the inline comments sample (⌘O)', () => open(s, SAMPLE), { shot: false });
        await s.shot('Start: a note with inline comment markup', 'initial', { explain: "The inline comments sample note, with its comment markup written inline." });
        await s.step('Run “Import inline comments from this note” from the palette', async () => {
          await s.runCommand('Threadglyph: Import inline comments from this note', 'import inline comments');
          await s.waitFor(() => document.querySelector('.modal-container .modal-title')?.textContent === 'Import inline comments', null, { what: 'the import preview' });
        }, { caption: 'Import preview: three threads', explain: "The command opens a preview (outlined): three threads with their message counts, one already resolved.", look: '.modal-container .modal' });
        s.group('Preview');
        s.equal('Preview lists the 3 threads with their message counts', await s.eval(() => [...document.querySelectorAll('.tg-import-item')].map((li) => [li.querySelector('.tg-quote').textContent, li.querySelector('.tg-import-meta').textContent])),
          [['plant the tomatoes early', '2 messages · Will be imported'], ['compost the fallen leaves', '1 message · resolved · Will be imported'], ['Water deeply twice a week', '1 message · Will be imported']]);
        await s.step('Click “Import 3”', async () => {
          await s.page.locator('.modal-container button', { hasText: 'Import 3' }).click();
          await s.waitFor(() => !document.querySelector('.modal-container'), null, { what: 'the preview to close' });
          await s.waitFor(() => (window.__uatNotices ?? []).some((n) => n.includes('imported')), null, { what: 'the import notice' });
        }, { caption: 'Imported; the panel lists the threads', explain: "After Import 3, the panel lists the three threads (outlined), and a notice says the note was not changed.", look: '.tg-panel .tg-card:not(.tg-card-new)' });
        s.group('Imported');
        s.check('Notice: 3 imported, note not changed', (await s.notices()).some((n) => n.includes('imported 3 thread(s). The note was not changed.')), (await s.notices()).join('\n'));
        s.equal('Three thread files written', (await threadFiles(s)).length, 3);
        s.equal('The note is byte-for-byte unchanged', await s.read(SAMPLE), inlineComments);
        await s.step('Run the import again', async () => {
          await s.runCommand('Threadglyph: Import inline comments from this note', 'import inline comments');
          await s.waitFor(() => !!document.querySelector('.modal-container .tg-import-list'), null, { what: 'the import preview' });
        }, { caption: 'Second import: nothing new', look: '.modal-container .modal', explain: "Running it again: the preview’s button reads “Nothing new to import” and is disabled." });
        s.group('Second import');
        const btn = await s.eval(() => { const b = [...document.querySelectorAll('.modal-container button')].find((x) => x.classList.contains('mod-cta')); return { text: b?.textContent, disabled: b?.disabled }; });
        s.equal('The button says “Nothing new to import” and is disabled', btn, { text: 'Nothing new to import', disabled: true });
        await s.press('Escape');
        await s.shot('End', 'final', { explain: "Where it ends: three threads, and the note byte-for-byte unchanged." });
      },
    },
    {
      name: 'Back up, lose a thread, restore only what is missing',
      weight: 'major',
      intro: {"headline": "This shows that a backup can bring back a lost thread without overwriting anything.", "context": "With two threads, you back them up. Then one thread’s file is deleted from disk, as if lost, and the plugin reloads with one thread. Restoring from the backup brings back only the missing thread and reports the other as already there; nothing that exists is overwritten."},
      tradeoffs: [{"option": "Restore only what is missing, never overwrite", "downside": "If a thread changed since the backup, you can’t roll it back from here.", "chosen": true}, {"option": "Restore everything, overwriting", "downside": "A true rollback, but it can undo replies written after the backup."}, {"option": "Ask thread by thread", "downside": "The most control, but slow and fiddly when there are many threads."}],
      summary: 'Pilot step 8: back up, delete one thread file, reload, restore from the backup. The lost thread comes back and the other is reported as already there.',
      fixtures: { [WELCOME]: welcome },
      async run(s) {
        await s.step('Open “Welcome” and comment on two passages', async () => {
          await open(s, WELCOME);
          await comment(s, 'repeat me', 'Keep me');
          await comment(s, 'list item', 'Lose me, then restore me');
        }, { shot: false });
        await s.shot('Start: two threads', 'initial', { explain: "Two threads: “Keep me”, and “Lose me, then restore me”." });
        await s.step('Run “Back up all threads” from the palette', async () => {
          await s.runCommand('Threadglyph: Back up all threads', 'back up all threads');
          await s.waitFor(() => (window.__uatNotices ?? []).some((n) => n.includes('backed up')), null, { what: 'the backup notice' });
        }, { shot: false });
        s.group('Backup');
        const notice = (await s.notices()).find((n) => n.includes('backed up')) ?? '';
        s.check('Notice: backed up 2 threads to the local exports folder', notice.includes('backed up 2 thread(s) to .threadglyph/exports/'), notice);
        const exports = (await s.files()).length; // dot-folders aren't indexed; check on disk
        const onDisk = await s.eval(async () => (await app.vault.adapter.list('.threadglyph/exports')).files);
        s.equal('One backup file in .threadglyph/exports/', onDisk.length, 1);
        void exports;
        const lost = (await s.eval(() => document.querySelector('.tg-panel .tg-card:not(.tg-card-new)[data-thread-id] + .tg-card[data-thread-id]')?.dataset.threadId));
        await s.step('Delete the “list item” thread’s file from disk, then reload the plugin', async () => {
          rmSync(`${s.vault}/threadglyph/threads/${lost}.json`);
          await s.reloadPlugin();
          await open(s, WELCOME);
          await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === 1, null, { what: 'one thread left' });
        }, { caption: 'After losing a file: one thread left', explain: "The second thread’s file was deleted from disk and the plugin reloaded: one thread is left (outlined).", look: '.tg-panel .tg-card:not(.tg-card-new)' });
        s.group('Lost');
        s.equal('One thread is left', (await cards(s)).map((c) => c.messages[0]), ['Keep me']);
        await s.step('Run “Restore threads from a backup” and pick the backup', async () => {
          await s.runCommand('Threadglyph: Restore threads from a backup', 'restore threads');
          await s.waitFor(() => !!document.querySelector('.modal-container .tg-restore-file'), null, { what: 'the backup list' });
          await s.page.locator('.modal-container .tg-restore-file').first().click();
          await s.waitFor(() => (window.__uatNotices ?? []).some((n) => n.includes('restored')), null, { what: 'the restore notice' });
          await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === 2, null, { what: 'two threads again' });
        }, { caption: 'Restored: both threads back', explain: "After restoring from the backup, both threads are back in reading order (outlined). The notice says 1 restored, 1 already existed.", look: '.tg-panel .tg-card:not(.tg-card-new)' });
        s.group('Restore');
        s.check('Notice: 1 restored, 1 already existed', (await s.notices()).some((n) => n.includes('restored 1 thread(s); 1 already existed')), (await s.notices()).join('\n'));
        s.equal('Both threads are back, in reading order', (await cards(s)).map((c) => [c.n, c.messages[0]]), [['1', 'Keep me'], ['2', 'Lose me, then restore me']]);
        s.equal('The note is unchanged', await s.read(WELCOME), welcome);
        await s.shot('End', 'final', { explain: "Where it ends: both threads, and an unchanged note." });
      },
    },
  ],
  story: { paths: [
    { name: 'Bring threads in, and keep them safe', says: 'Import inline comments without touching the note, then back up and restore.',
      steps: [
        { case: 'Import inline comments without touching the note', says: 'The import previews three threads and leaves the note byte-for-byte as it was.' },
        { case: 'Back up, lose a thread, restore only what is missing', says: 'A restore adds the missing thread and overwrites nothing.' },
      ] },
  ] },
};
