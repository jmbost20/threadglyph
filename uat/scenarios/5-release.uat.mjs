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
  ],
  story: { paths: [
    { name: 'Install, and remove cleanly', says: 'The release files install into a fresh vault; switching the plugin off leaves the note as it was.',
      steps: [{ case: 'Turning Threadglyph off leaves the note as it was', says: 'Switch the plugin off: the highlight goes, the note and the thread file stay.' }] },
  ] },
};
