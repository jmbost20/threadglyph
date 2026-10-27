/**
 * UAT: the 0.3.1 fixes (PRs #40–#47), driven the way the owner works: drag-select, ⌘/, typing,
 * the command palette, the panel and Reading view. Synthetic notes only.
 */
import { DIR, cards, comment, open } from '../fixtures.mjs';

const LIST = `${DIR}/Todo list.md`;
const list = `# Plan

- TODO fix the parser
- write docs
- TODO later
`;

const LINKS = `${DIR}/Hidden copies.md`;
const links = `# Hidden copies

See [docs](foo) for details,
then foo and foo again.
`;

const SCRATCH = `${DIR}/Scratch.md`;
const RENAMED = `${DIR}/Scratch renamed.md`;
const scratch = `# Scratch

A sentence that will travel with its note.
`;

/** The text of the panel's detached-thread message, or null. */
const problem = (s) => s.eval(() => document.querySelector('.tg-panel .tg-anchor-problem')?.textContent ?? null);
/** The quote of the focused card. */
const focusedQuote = async (s) => (await cards(s)).find((c) => c.focused)?.quote ?? null;

export default {
  feature: '0.3.1 fixes',
  summary: 'The fixes going into 0.3.1: short quotes no longer jump, stepping visits every thread, Reading view highlights the right copy, and threads on deleted notes can be found again.',
  scenarios: [
    {
      name: 'A one-word thread asks for a reattach instead of jumping to another copy',
      weight: 'major',
      intro: {
        headline: 'This shows that a thread on a short word no longer moves to a different copy of that word when its own line is deleted.',
        context: 'A list has “TODO” twice. You comment on the first one, then delete that list item. Before 0.3.1 the thread quietly attached itself to the other “TODO” and highlighted it. Now it notices that none of the words around it are left, shows the detached message, and waits for you to reattach it.',
      },
      tradeoffs: [
        { option: 'Ask for a reattach when a short quote’s surroundings are gone', downside: 'A short quote whose neighbours were all rewritten asks for a reattach even if it is still the right place.', chosen: true },
        { option: 'Keep following the only copy left', downside: 'The thread can silently point at the wrong passage, and Ask AI would quote it.' },
      ],
      summary: 'Comment on the first “TODO”, delete its list item: the card says the words appear elsewhere and offers Reattach; nothing is highlighted. Reattach to the other “TODO” fixes it.',
      fixtures: { [LIST]: list },
      async run(s) {
        await s.step('Open “Todo list” and comment on the first “TODO”', async () => {
          await open(s, LIST);
          await comment(s, 'TODO', 'Which parser bug?');
        }, { caption: 'Thread on the first “TODO”', look: '.cm-content .tg-anchor', explain: 'One thread on the first “TODO” (outlined). The same word appears again two lines down.' });
        await s.step('Delete the list item “TODO fix the parser”', async () => {
          await s.eval(() => {
            const ed = app.workspace.getMostRecentLeaf().view.editor;
            const line = ed.getValue().split('\n').findIndex((l) => l.includes('TODO fix the parser'));
            ed.replaceRange('', { line, ch: 0 }, { line: line + 1, ch: 0 });
          });
          await s.waitFor(() => !!document.querySelector('.tg-panel .tg-anchor-problem'), null, { what: 'the detached message', timeout: 12000 });
        }, { caption: 'The thread asks for a reattach', look: '.tg-panel .tg-anchor-problem', explain: 'With its list item gone, the card shows why it is detached (outlined): the same words appear elsewhere, so select the right passage and reattach. The other “TODO” is not highlighted.' });
        s.group('After deleting the passage');
        s.check('The card explains the words appear elsewhere', /elsewhere in the note/.test((await problem(s)) ?? ''), await problem(s));
        s.equal('No highlight on the other “TODO”', await s.eval(() => document.querySelectorAll('.cm-content .tg-anchor').length), 0);
        await s.step('Select the remaining “TODO” and click Reattach to selection', async () => {
          await s.selectText('TODO');
          await s.page.locator('.tg-panel .tg-anchor-problem button', { hasText: 'Reattach to selection' }).click();
          await s.waitFor(() => !document.querySelector('.tg-panel .tg-anchor-problem'), null, { what: 'the thread to reattach' });
        }, { caption: 'Reattached by hand', look: '.cm-content .tg-anchor, .tg-panel .tg-card', explain: 'You chose the passage: the thread is attached to “TODO later” and highlighted there.' });
        s.group('After reattaching');
        s.equal('The other “TODO” is now highlighted', await s.eval(() => [...document.querySelectorAll('.cm-content .tg-anchor')].map((a) => a.textContent)), ['TODO']);
        s.equal('The note holds only your own edit', await s.read(LIST), list.replace('- TODO fix the parser\n', ''));
        await s.shot('End', 'final', { explain: 'Where it ends: one thread, attached where you put it.' });
      },
    },
    {
      name: 'Threads on missing notes can be found and moved back',
      weight: 'major',
      intro: {
        headline: 'This shows the new command for threads whose note was deleted or renamed outside Obsidian.',
        context: 'A note with a thread is replaced by a renamed copy, as happens when another app or a sync conflict renames it. Its thread had no panel to appear in. The new command lists it, and Move puts it on the open note, where the passage is found again.',
      },
      tradeoffs: [
        { option: 'A command that lists them, with Move and Delete', downside: 'You have to know to run it; nothing tells you at the moment the note goes.', chosen: true },
        { option: 'A notice when a note with threads is deleted', downside: 'Tells you once, but gives no way back to the threads later.' },
      ],
      summary: 'Comment on “Scratch”, replace it with “Scratch renamed” outside Obsidian’s rename, run “Show threads on missing notes”, Move: the thread is on the renamed note, passage found.',
      fixtures: { [SCRATCH]: scratch },
      async run(s) {
        await s.step('Open “Scratch” and comment on “travel with its note”', async () => {
          await open(s, SCRATCH);
          await comment(s, 'travel with its note', 'Does this survive a rename elsewhere?');
        }, { shot: false });
        await s.step('Replace “Scratch” with a renamed copy (as another app would)', async () => {
          await s.eval(async ({ from, to }) => {
            const file = app.vault.getAbstractFileByPath(from);
            const text = await app.vault.read(file);
            await app.vault.create(to, text);
            await app.vault.delete(file);
          }, { from: SCRATCH, to: RENAMED });
          await open(s, RENAMED);
        }, { caption: 'The renamed note has no threads', look: '.tg-panel', explain: 'The copy has the same text, but its panel is empty: the thread still points at the old name.' });
        s.equal('The renamed note shows no thread', (await cards(s)).length, 0);
        await s.step('Run “Threadglyph: Show threads on missing notes”', async () => {
          await s.runCommand('Threadglyph: Show threads on missing notes', 'threads on missing notes');
          await s.waitFor(() => !!document.querySelector('.modal .tg-missing-path'), null, { what: 'the list of threads on missing notes' });
        }, { caption: 'The thread on the missing note is listed', look: '.modal', explain: 'The list shows the old note’s path, the first comment and when it was last active, with Delete and Move to “Scratch renamed”.' });
        s.group('The list');
        s.equal('It names the missing note', await s.eval(() => document.querySelector('.modal .tg-missing-path')?.textContent), SCRATCH);
        await s.step('Click Move to “Scratch renamed”', async () => {
          await s.page.locator('.modal button', { hasText: 'Move to “Scratch renamed”' }).click();
          await s.waitFor(() => document.querySelector('.modal')?.textContent?.includes('Every thread’s note is in the vault'), null, { what: 'the list to empty' });
          await s.press('Escape');
          await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === 1, null, { what: 'the thread card' });
        }, { caption: 'Moved: the passage is found on the renamed note', look: '.cm-content .tg-anchor, .tg-panel .tg-card', explain: 'The thread is on “Scratch renamed” now, and because the text is the same, its passage is highlighted straight away.' });
        s.group('After moving');
        const [card] = await cards(s);
        s.equal('The card quotes the passage and is attached', [card?.quote, card?.detached], ['travel with its note', false]);
        s.equal('The renamed note is unchanged', await s.read(RENAMED), scratch);
        await s.shot('End', 'final', { explain: 'Where it ends: the thread lives on the renamed note.' });
      },
    },
    {
      name: 'Next thread visits threads that start at the same place',
      weight: 'minor',
      intro: {
        headline: 'This shows ⌥⌘] stepping through two threads that begin on the same word.',
        context: 'One thread is on “TODO”, another on “TODO fix the parser”. Both start at the same place. Before 0.3.1, ⌥⌘] skipped the second one.',
      },
      tradeoffs: [
        { option: 'Step from the thread you are on, in a fixed order', downside: 'None found.', chosen: true },
      ],
      summary: 'Two threads starting on the same “TODO”, then ⌥⌘] three times: both are visited.',
      fixtures: { [LIST]: list },
      async run(s) {
        await s.step('Comment on “TODO” and on “TODO fix the parser”', async () => {
          await open(s, LIST);
          await comment(s, 'TODO', 'Short one');
          await comment(s, 'TODO fix the parser', 'Long one');
          // Live Preview shows the heading as “Plan”, without its “# ”.
          await s.clickLine('Plan');
        }, { shot: false });
        const seen = [];
        for (let i = 0; i < 3; i++) {
          await s.step(`Press ⌥⌘] (${i + 1})`, async () => {
            await s.press('Meta+Alt+BracketRight');
            await s.page.waitForTimeout(300);
          }, { caption: `⌥⌘] ${i + 1}`, look: '.tg-panel .tg-card-focused', explain: 'The focused card (outlined) follows each press.' });
          seen.push(await focusedQuote(s));
        }
        s.group('Stepping');
        s.equal('Both threads are visited, then it wraps', seen, ['TODO', 'TODO fix the parser', 'TODO']);
        await s.shot('End', 'final', { explain: 'Where it ends: back on the first thread, after visiting both.' });
      },
    },
    {
      name: 'Reading view highlights the right copy when another hides in a link',
      weight: 'minor',
      intro: {
        headline: 'This shows Reading view highlighting the copy you commented on, even when the same word hides in a link address above it.',
        context: 'The paragraph has “foo” in a link address (not shown when rendered) and twice in plain text. You comment on the first plain “foo”. Before 0.3.1, Reading view counted the hidden copy and highlighted the second one.',
      },
      tradeoffs: [
        { option: 'Ignore copies hidden in link addresses, comments and embeds', downside: 'Other syntax that renders differently (footnotes, heading links) is still not modelled.', chosen: true },
      ],
      summary: 'Comment on the first plain “foo”, switch to Reading view: the highlight is on “then foo”, not “and foo”.',
      fixtures: { [LINKS]: links },
      async run(s) {
        await s.step('Comment on the first plain “foo”', async () => {
          await open(s, LINKS);
          await comment(s, 'foo', 'This one', { nth: 1 });
        }, { shot: false });
        await s.step('Switch to Reading view', async () => {
          // This note's own pane: earlier cases can leave other notes' Reading views in the page.
          await s.eval(async (path) => {
            const leaf = app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === path);
            await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: 'preview' } });
          }, LINKS);
          await s.waitFor((path) => app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === path)
            ?.view.containerEl.querySelector('.markdown-preview-view .tg-anchor'), LINKS, { what: 'the highlight in Reading view' });
        }, { caption: 'Reading view: the first plain “foo” is highlighted', look: '.markdown-preview-view .tg-anchor', explain: 'The highlight (outlined) is on “then foo”, the copy you commented on.' });
        s.group('Reading view');
        const before = await s.eval((path) => app.workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === path)
          ?.view.containerEl.querySelector('.markdown-preview-view .tg-anchor')?.previousSibling?.textContent ?? null, LINKS);
        s.check('The highlight follows “then ”', before?.endsWith('then ') === true, JSON.stringify(before));
        s.equal('The note is unchanged', await s.read(LINKS), links);
        await s.shot('End', 'final', { explain: 'Where it ends: Reading view, with only the copy you commented on highlighted.' });
      },
    },
  ],
  story: { paths: [
    { name: 'Threads stay where you put them', says: 'A thread never silently moves to the wrong passage, and threads on a lost note can be brought back.',
      steps: [
        { case: 'A one-word thread asks for a reattach instead of jumping to another copy', says: 'Delete a short quote’s line: the thread asks instead of guessing.', edges: ['Reading view highlights the right copy when another hides in a link'] },
        { case: 'Threads on missing notes can be found and moved back', says: 'A note renamed elsewhere: list its threads and move them back.', edges: ['Next thread visits threads that start at the same place'] },
      ] },
  ] },
};
