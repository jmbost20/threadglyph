/** UAT: image titles and image threads (docs/pilot.md step 4). Synthetic gradient images only. */
import { DIR, cards, imageFiles, imageTitles, images, open } from '../fixtures.mjs';

const TITLES = `${DIR}/Image titles.md`;
const IMAGES = `${DIR}/Images.md`;
const fixtures = () => ({ [TITLES]: imageTitles, [IMAGES]: images, ...imageFiles() });

export default {
  feature: 'Image titles and image threads',
  summary: 'Every supported image gets a title pill with Comment, drawn by the plugin only; unsupported and missing images get no pill.',
  story: { paths: [
    { name: 'Comment on an image', says: 'Every image gets a title pill; its Comment button starts an image thread.',
      steps: [
        { case: 'Title pills name each image, and Comment starts an image thread', says: 'Click Comment on an image’s title pill to start a thread on the image.',
          edges: ['HEIC and missing images get a clear message'] },
      ] },
  ] },
  get scenarios() {
    return [
      {
        name: 'Title pills name each image, and Comment starts an image thread',
        weight: 'major',
        intro: {"headline": "This shows how the image titles look. Check that each image’s title pill reads right.", "context": "Every image in the note gets a small pill under it, with its title and a Comment button, drawn by the plugin; nothing is written into the note. The title comes from the image’s alias, else its alt text, else its file name. Clicking Comment starts a thread about the image, with a preview of it in the card."},
        tradeoffs: [{"option": "A pill drawn by the plugin under each image", "downside": "It adds a line under every image, even ones you will never comment on.", "chosen": true}, {"option": "Show the pill only on hover", "downside": "A cleaner page, but the titles are invisible until you point at an image, and it doesn’t work from the keyboard."}, {"option": "Write the title into the note as a caption", "downside": "Visible everywhere, but it edits your notes, which the plugin promises never to do."}],
        summary: 'Pilot step 4: titles come from the alias, the alt text, else the file name. Clicking Comment opens an image thread with a preview. The note is never written to.',
        review: 'Check the title pills and the image preview in the thread card look right.',
        fixtures: fixtures(),
        async run(s) {
          await s.step('Open “Image titles” (⌘O)', async () => {
            await open(s, TITLES);
            await s.waitFor(() => document.querySelectorAll('.cm-content .tg-image-title').length >= 3, null, { what: 'three title pills' });
          }, { caption: 'Three images, three title pills', explain: "The Image titles note just after opening: three images, each with a pill (outlined). The first takes its title from the alias “Evening sky”, the second from its file name, the third from its alt text.", look: '.cm-content .tg-image-title' });
          await s.shot('Start: title pills under each image', 'initial', { look: '.cm-content .tg-image-title', explain: "The same view, kept as the starting point the later slides are compared with." });
          s.group('Titles');
          s.equal('Titles: alias, then file name, then alt text', await s.eval(() => [...document.querySelectorAll('.cm-content .tg-image-title-text')].map((t) => t.textContent)), ['Evening sky', 'Sandbox meadow', 'A green meadow']);
          s.group('Image thread');
          await s.step('Click Comment on “Evening sky”', async () => {
            await s.page.locator('.cm-content .tg-image-title', { hasText: 'Evening sky' }).locator('.tg-image-comment').click();
            await s.waitFor(() => document.activeElement?.matches('.tg-card-new textarea'), null, { what: 'the new image-thread box' });
          }, { caption: 'New image thread with a preview', explain: "Clicking Comment on “Evening sky” opens a new thread box in the panel (outlined), showing the image so you know what you are commenting on.", look: '.tg-card-new' });
          s.check('The new thread shows the image', await s.eval(() => !!document.querySelector('.tg-card-new .tg-image img')));
          await s.step('Type a comment and press ⌘↩', async () => {
            await s.type('Is the sky too dark?');
            await s.press('Meta+Enter');
            await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === 1, null, { what: 'the image thread card' });
          }, { caption: 'The image thread, with its preview', explain: "After typing and ⌘↩, the thread card keeps the image preview and its file name, Sandbox sky.png (outlined).", look: '.tg-panel .tg-card:not(.tg-card-new)' });
          const c = await cards(s);
          s.equal('One image thread with the comment', c.map((x) => x.messages), [['Is the sky too dark?']]);
          s.check('The card shows the image preview and its file name', await s.eval(() => !!document.querySelector('.tg-panel .tg-card .tg-image img') && document.querySelector('.tg-panel .tg-card .tg-image-name')?.textContent === 'Sandbox sky.png'));
          s.group('Nothing written into notes');
          s.equal('“Image titles” is unchanged', await s.read(TITLES), imageTitles);
          await s.shot('End', 'final', { explain: "Where it ends: one image thread, and the note itself unchanged." });
        },
      },
      {
        name: 'HEIC and missing images get a clear message',
        weight: 'minor',
        intro: {"headline": "This shows what you are told when an image can’t be commented on. Check the messages are clear.", "context": "There are two problem embeds at the bottom of the Images note: a HEIC photo, which Obsidian can’t display, and a link to an image file that doesn’t exist. The HEIC gets no Comment pill; trying to comment on it shows a notice naming the supported formats. The missing file still shows a pill, and the notice that it is missing appears only when you click Comment."},
        tradeoffs: [{"option": "Missing file: show the pill, explain on click", "downside": "You only learn the file is missing after trying.", "chosen": true}, {"option": "Missing file: no pill, like HEIC", "downside": "Consistent, but the broken link gives no sign that anything is wrong."}, {"option": "Missing file: a warning pill (“file not found”) instead of Comment", "downside": "Clear up front, but it is a new visual state to design and test."}],
        summary: 'Pilot step 4: “HEIC and missing files get a clear message instead.” The HEIC embed is not offered for comments; commenting on it, or on the missing file, explains why.',
        review: 'Are the HEIC and missing-file messages clear enough? Note: the missing file still shows a Comment pill; the message only appears on click.',
        fixtures: fixtures(),
        async run(s) {
          await s.step('Open “Images” (⌘O) and scroll to the bottom', async () => {
            await open(s, IMAGES);
            await s.eval(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; ed.scrollIntoView({ from: { line: ed.lastLine(), ch: 0 }, to: { line: ed.lastLine(), ch: 0 } }, true); });
            await s.page.waitForTimeout(500);
          }, { shot: false });
          await s.shot('Start: the HEIC and missing-file embeds', 'initial', { explain: "The bottom of the Images note, with the HEIC embed and the missing-file embed. There is no pill for the HEIC one." });
          const titles = await s.eval(() => [...document.querySelectorAll('.cm-content .tg-image-title-text')].map((t) => t.textContent));
          s.group('HEIC');
          s.check('No Comment pill on the HEIC file', !titles.some((t) => /heic|Not supported/i.test(t)), titles.join(', '));
          // Never click the embed itself: Obsidian opens an unsupported file in another app.
          await s.step('Select “Unsupported format”, press End to reach the HEIC embed, then ⌘/', async () => {
            await s.selectText('Unsupported format');
            await s.press('End');
            await s.press('Meta+/');
            await s.page.waitForTimeout(600);
          }, { caption: 'Commenting on the HEIC embed', look: '.notice', explain: "With the cursor on the HEIC embed, ⌘/ shows a notice (outlined) that HEIC isn’t supported, listing the formats that are. No thread box opens." });
          const heic = await s.notices();
          s.check('A notice explains HEIC isn’t supported and names the formats that are', heic.some((t) => t.includes('HEIC images are not supported') && /PNG/.test(t)), heic.join('\n') || '(no notice)');
          s.check('No new-thread box opened for the HEIC file', !(await s.eval(() => !!document.querySelector('.tg-card-new'))));
          await s.press('Escape');
          s.group('Missing file');
          const missingPill = titles.find((t) => /Nowhere/i.test(t));
          s.attach('Title pills on this note', titles.join('\n'));
          if (missingPill) {
            await s.step('Click Comment on the “Nowhere” pill (the file does not exist)', async () => {
              await s.page.locator('.cm-content .tg-image-title', { hasText: 'Nowhere' }).locator('.tg-image-comment').click();
              await s.page.waitForTimeout(600);
            }, { caption: 'Commenting on a missing image', look: '.notice', explain: "Clicking Comment on the “Nowhere” pill shows a notice (outlined) that Nowhere.png is not in this vault." });
          } else {
            await s.step('Select “Missing file”, press End, then ⌘/', async () => { await s.selectText('Missing file'); await s.press('End'); await s.press('Meta+/'); await s.page.waitForTimeout(600); }, { caption: 'Commenting on a missing image', look: '.notice', explain: "With the cursor on the missing-file embed, ⌘/ shows a notice (outlined) that Nowhere.png is not in this vault." });
          }
          const missing = await s.notices();
          s.check('A notice says the file is not in the vault, by name', missing.some((t) => t.includes('Image file not found in this vault: Nowhere.png')), missing.join('\n') || '(no notice)');
          s.equal('“Images” is unchanged', await s.read(IMAGES), images);
          await s.shot('End', 'final', { explain: "Where it ends: no threads were created, and the note is unchanged." });
        },
      },
    ];
  },
};
