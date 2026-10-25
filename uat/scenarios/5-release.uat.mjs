/**
 * UAT: the release candidate's install and removal (docs/dev/pilot.md steps 9 and 11).
 * The harness installs the three release files (main.js, manifest.json, styles.css) into a
 * fresh synthetic vault for every case; this one checks that switching the plugin off leaves
 * nothing behind in the note.
 */
import { WELCOME, comment, open, welcome } from '../fixtures.mjs';

export default {
  feature: 'Install and removal',
  summary: 'The release files install into a fresh vault, and turning the plugin off leaves your notes exactly as they were.',
  scenarios: [
    {
      name: 'Turning Threadglyph off leaves the note as it was',
      weight: 'minor',
      intro: {
        headline: 'This shows that switching Threadglyph off removes its marks and leaves the note untouched.',
        context: 'Threadglyph draws its highlights and numbers on screen; nothing is written into the note. With a thread in place, the plugin is switched off (as the toggle in Settings → Community plugins does). The highlight disappears, the note file is byte-for-byte the same, and no errors are logged. The thread files stay, so switching it back on picks up where you left off.',
      },
      tradeoffs: [
        { option: 'Keep the thread files when the plugin is off or removed', downside: 'Removing the plugin leaves two folders behind until you delete them.', chosen: true },
        { option: 'Delete the thread files on removal', downside: 'Tidier, but a reinstall would lose every comment.' },
      ],
      summary: 'Pilot steps 9 and 11: with a thread on “list item”, disable the plugin. The highlight goes, the note is unchanged, the thread file stays, and nothing is logged as an error.',
      fixtures: { [WELCOME]: welcome },
      async run(s) {
        await s.step('Open “Welcome” and comment on “list item”', async () => {
          await open(s, WELCOME);
          await comment(s, 'list item', 'Still here after a reinstall?');
        }, { shot: false });
        await s.shot('Start: one thread, highlighted in the note', 'initial', { look: '.cm-content .tg-anchor', explain: 'One thread on “list item”: the highlight and its number (outlined) are drawn by the plugin, not written into the note.' });
        const errors = [];
        const listen = (m) => { if (m.type() === 'error') errors.push(m.text()); };
        s.page.on('console', listen);
        await s.step('Turn Threadglyph off (as Settings → Community plugins does)', async () => {
          await s.eval(() => app.plugins.disablePluginAndSave('threadglyph'));
          await s.waitFor(() => !document.querySelector('.cm-content .tg-anchor'), null, { what: 'the highlight to go' });
        }, { caption: 'Plugin off: the highlight is gone', look: '.cm-content', explain: 'With the plugin switched off, its highlight and number are gone from the note (outlined), because they were only ever drawn on screen.' });
        s.group('With the plugin off');
        s.check('No Threadglyph highlight or number in the note', await s.eval(() => !document.querySelector('.cm-content .tg-anchor, .cm-content .tg-badge')));
        s.equal('The note is byte-for-byte unchanged', await s.read(WELCOME), welcome);
        s.equal('The thread file stays, for a reinstall', (await s.files()).filter((p) => p.startsWith('threadglyph/threads/')).length, 1);
        s.page.off('console', listen);
        s.check('No errors logged while switching it off', errors.length === 0, errors.join('\n'));
        await s.shot('End', 'final', { explain: 'Where it ends: the plugin is off, the note reads exactly as before, and the thread is kept on disk for when it is switched back on.' });
      },
    },
    {
      name: 'Turning Threadglyph off also clears Reading view',
      weight: 'minor',
      intro: {
        headline: 'This shows that switching Threadglyph off removes its highlight and number from Reading view too, not only from the editor.',
        context: 'Reading view keeps what it drew until the note is rendered again, so the plugin removes its own marks when it is switched off. With a thread in place, the note is switched to Reading view, then the plugin is turned off.',
      },
      tradeoffs: [
        { option: 'Remove the marks when the plugin unloads', downside: 'A little cleanup code that has to match what Reading view adds.', chosen: true },
        { option: 'Leave them until the note re-renders', downside: 'Stale numbers stay on screen and still try to open a panel that is gone.' },
      ],
      summary: 'With a thread on “list item”, switch to Reading view (the highlight and number show), then disable the plugin. Both are gone and the note is unchanged.',
      fixtures: { [WELCOME]: welcome },
      async run(s) {
        await s.step('Open “Welcome” and comment on “list item”', async () => {
          await open(s, WELCOME);
          await comment(s, 'list item', 'Gone from Reading view too?');
        }, { shot: false });
        await s.step('Switch the note to Reading view (book icon, top right of the note)', async () => {
          await s.eval(async () => {
            const leaf = app.workspace.getLeavesOfType('markdown')[0];
            await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: 'preview' } });
          });
          await s.waitFor(() => document.querySelector('.markdown-preview-view .tg-badge'), null, { what: 'the number in Reading view' });
        }, { caption: 'Reading view: the passage is highlighted and numbered', look: '.markdown-preview-view .tg-anchor', explain: 'In Reading view the highlight and its number (outlined) are added to the rendered note by the plugin.' });
        await s.step('Turn Threadglyph off', async () => {
          await s.eval(() => app.plugins.disablePluginAndSave('threadglyph'));
          await s.waitFor(() => !document.querySelector('.markdown-preview-view .tg-badge'), null, { what: 'the number to go' });
        }, { caption: 'Plugin off: Reading view shows the plain note', look: '.markdown-preview-view', explain: 'The highlight and number are gone from Reading view right away; the note text is unchanged.' });
        s.group('Reading view with the plugin off');
        s.check('No Threadglyph highlight, number or image title left', await s.eval(() => !document.querySelector('.markdown-preview-view .tg-anchor, .markdown-preview-view .tg-badge, .markdown-preview-view .tg-image-title')));
        s.equal('The note is byte-for-byte unchanged', await s.read(WELCOME), welcome);
        await s.shot('End', 'final', { explain: 'Where it ends: Reading view shows the note exactly as Obsidian renders it without Threadglyph.' });
      },
    },
  ],
  story: { paths: [
    { name: 'Install, and remove cleanly', says: 'The release files install into a fresh vault; switching the plugin off leaves the note as it was.',
      steps: [{ case: 'Turning Threadglyph off leaves the note as it was', says: 'Switch the plugin off: the highlight goes, the note and the thread file stay.', edges: ['Turning Threadglyph off also clears Reading view'] }] },
  ] },
};
