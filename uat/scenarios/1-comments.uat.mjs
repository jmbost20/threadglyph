/**
 * UAT: comment threads on text (docs/pilot.md steps 1–3, plus the October 1 feedback fixes).
 * Everything is driven the way the owner does it: drag-select, ⌘/, typing, ⌘↩, panel clicks
 * and keys. Synthetic notes only.
 */
import { WELCOME, cards, comment, headerMeta, open, threadFiles, welcome } from '../fixtures.mjs';

const fixtures = { [WELCOME]: welcome };

export default {
  feature: 'Comment threads on text',
  summary: 'Select text, press ⌘/, write — the passage is highlighted, numbered in reading order, and the thread lives beside the note, never inside it.',
  scenarios: [
    {
      name: 'Comment, then a comment higher up renumbers in reading order',
      weight: 'major',
      intro: {"headline": "This shows the basic comment loop: highlight, number and card, and that numbers follow reading order.", "context": "You comment on a list item, then on a phrase above it. Watch the highlight and the small raised number appear in the note, the matching card in the panel, and the numbers re-order when the higher comment arrives. Resolving one keeps its number. The note file itself is never edited; threads are stored beside it."},
      tradeoffs: [{"option": "Number by reading order, renumbering when a higher comment arrives", "downside": "A thread’s number can change after you have referred to it (“see 2”), which can confuse a conversation.", "chosen": true}, {"option": "Number by creation order, fixed forever", "downside": "Numbers stay stable, but the note reads out of order (3 above 1), which is harder to scan."}, {"option": "No numbers, only highlights", "downside": "Cleaner, but no quick way to match a highlight to its card once there are several."}],
      summary: 'Pilot step 1: comment on a list item, then on a phrase above it. The new one becomes 1. Resolving keeps the numbers, and everything survives a plugin reload. The note itself never changes.',
      review: 'Look at the highlights, the raised numbers and the cards. Does the thread layout read the way you expect?',
      fixtures,
      async run(s) {
        await s.step('Open “Welcome” with the quick switcher (⌘O)', () => open(s, WELCOME), { shot: false });
        await s.shot('Start: a note with no threads', 'initial', { explain: "The Welcome note before anything happens: no highlights in the note, and the panel on the right has no threads." });

        await s.step('Drag-select “list item” and press ⌘/', async () => {
          await s.selectText('list item');
          await s.press('Meta+/');
          await s.waitFor(() => document.activeElement?.matches('.tg-card-new textarea'), null, { what: 'the new-thread box' });
        }, { caption: 'New-thread box with the quote, keyboard already in it', explain: "After drag-selecting “list item” and pressing ⌘/, a new-thread box opens in the panel (outlined). It quotes the selection, and the cursor is already in it, so you can type straight away.", look: '.tg-card-new' });
        s.group('New thread box');
        s.equal('The box quotes the selection', await s.eval(() => document.querySelector('.tg-card-new .tg-quote')?.textContent), 'list item');

        await s.step('Type “Worth a closer look” and press ⌘↩', async () => {
          await s.type('Worth a closer look');
          await s.press('Meta+Enter');
          await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === 1, null, { what: 'the thread card' });
        }, { caption: 'Thread 1: highlight in the note, number 1 on both', explain: "After typing and ⌘↩: the passage is highlighted in the note with a raised 1, and the card in the panel carries the same 1. The keyboard has moved to the card’s reply box.", look: '.cm-content .tg-anchor, .cm-content .tg-badge, .tg-panel .tg-card-number' });
        s.group('First thread');
        let c = await cards(s);
        s.equal('One card, numbered 1, quoting the passage', c.map((x) => [x.n, x.quote, x.messages]), [['1', 'list item', ['Worth a closer look']]]);
        s.equal('The note highlights the passage', await s.eval(() => [...document.querySelectorAll('.cm-content .tg-anchor')].map((a) => a.textContent)), ['list item']);
        s.equal('The note shows the same number', await s.eval(() => [...document.querySelectorAll('.cm-content .tg-badge')].map((b) => b.textContent)), ['1']);
        s.check('After ⌘↩ the keyboard is in the thread’s reply box (Oct 1 fix)', await s.eval(() => document.activeElement?.matches('.tg-card textarea[aria-label="Reply"]')), await s.eval(() => document.activeElement?.outerHTML?.slice(0, 160)));

        await s.step('Comment on the first “repeat me”, which is higher in the note', () => comment(s, 'repeat me', 'Is this repeated on purpose?'), { caption: 'The higher comment is now 1; the list item became 2', look: '.cm-content .tg-badge, .tg-panel .tg-card-number', explain: "A second comment, on “repeat me”, which sits higher in the note. It takes number 1 and the list item becomes 2, in the note and in the panel (numbers outlined)." });
        s.group('Reading order');
        c = await cards(s);
        s.equal('Cards follow reading order: the higher passage is 1', c.map((x) => [x.n, x.quote]), [['1', 'repeat me'], ['2', 'list item']]);
        s.equal('Note badges renumbered to match', await s.eval(() => [...document.querySelectorAll('.cm-content .tg-badge')].map((b) => b.textContent)), ['1', '2']);
        s.equal('Header counts two open threads', await headerMeta(s), '2 open');

        await s.step('Click Resolve on thread 2 (“list item”)', async () => {
          await s.page.locator('.tg-panel .tg-card', { hasText: 'Worth a closer look' }).locator('.tg-card-footer button', { hasText: 'Resolve' }).click();
          await s.waitFor(() => document.querySelector('.tg-panel .tg-filter-option')?.dataset.count === '1', null, { what: 'the Open count to drop to 1' });
        }, { caption: 'Thread 2 resolved: off the Open list', explain: "Resolve on the list-item thread: it leaves the Open list, and the filter counts read Open 1 · Resolved 1 (outlined).", look: '.tg-panel .tg-filter-option, .tg-panel .tg-card:not(.tg-card-new)' });
        s.group('Resolving');
        s.equal('Header: 1 open · 1 resolved', await headerMeta(s), '1 open · 1 resolved');
        s.equal('Filter counts: Open 1 · Resolved 1 · All 2', await s.eval(() => [...document.querySelectorAll('.tg-panel .tg-filter-option')].map((b) => b.textContent.trim() + ' ' + b.dataset.count)), ['Open 1', 'Resolved 1', 'All 2']);
        await s.step('Show All', async () => {
          await s.page.locator('.tg-panel .tg-filter-option', { hasText: 'All' }).click();
          await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === 2, null, { what: 'both cards' });
        }, { caption: 'All: the resolved thread keeps its number', explain: "The All filter shows both threads. The resolved one still carries 2, so numbers don’t shuffle when something is resolved.", look: '.tg-panel .tg-card .tg-card-number' });
        c = await cards(s);
        s.equal('Resolving keeps the numbers', c.map((x) => [x.n, x.quote, x.resolved]), [['1', 'repeat me', false], ['2', 'list item', true]]);

        s.group('Stored beside the note, not in it');
        s.equal('The note is byte-for-byte unchanged', await s.read(WELCOME), welcome);
        s.equal('Two thread files under threadglyph/threads/', (await threadFiles(s)).length, 2);
        // AGENTS.md: tracked thread records must never contain quoted note text (anchors, which do, live in .threadglyph/).
        const tracked = (await Promise.all((await threadFiles(s)).map((f) => s.read(f)))).join('\n');
        s.check('Tracked thread files hold no quoted note text (privacy rule)', !tracked.includes('repeat me') && !tracked.includes('list item'), tracked.slice(0, 600));

        await s.step('Reload the plugin and reopen the note', async () => {
          await s.reloadPlugin();
          await open(s, WELCOME);
          await s.waitFor(() => document.querySelectorAll('.cm-content .tg-anchor').length === 2, null, { what: 'the highlights to come back' });
        }, { shot: false });
        s.group('After a plugin reload');
        s.equal('Both highlights come back', await s.eval(() => [...document.querySelectorAll('.cm-content .tg-anchor')].map((a) => a.textContent)), ['repeat me', 'list item']);
        s.equal('Note still unchanged', await s.read(WELCOME), welcome);
        await s.shot('End: threads back after a reload', 'final', { explain: "After reloading the plugin and reopening the note, both highlights and their numbers come back from the stored thread files. The note is still byte-for-byte unchanged." });
      },
    },
    {
      name: 'Step through threads from the keyboard',
      weight: 'minor',
      intro: {"headline": "This shows moving between a note’s threads with the keyboard alone.", "context": "With two threads in the note and the cursor above them, ⌥⌘] jumps to the next thread and ⌥⌘[ to the previous one, marking the matching card as focused. ⌥⌘/ with the cursor inside a highlight goes straight to that thread’s reply box. Check that the focused card is obvious enough."},
      tradeoffs: [{"option": "Bracket chords (⌥⌘] and ⌥⌘[), like next and previous tab", "downside": "Three-key chords are hard to discover and easy to forget without a hint.", "chosen": true}, {"option": "Single keys while the panel has focus (j/k style)", "downside": "Faster, but only after clicking into the panel, and they can clash with typing."}, {"option": "Arrow buttons in the panel header", "downside": "Easy to find, but needs the mouse, which defeats a keyboard flow."}],
      summary: 'Pilot step 2: ⌥⌘] and ⌥⌘[ move through the note’s threads in order; ⌥⌘/ inside a highlight jumps to its reply box.',
      fixtures,
      async run(s) {
        await s.step('Open “Welcome” and comment on two passages', async () => {
          await open(s, WELCOME);
          await comment(s, 'repeat me', 'First passage');
          await comment(s, 'list item', 'Second passage');
        }, { shot: false });
        await s.step('Click at the start of the note’s first paragraph', () => s.clickLine('Select any sentence'), { shot: false });
        await s.shot('Start: two threads, cursor above them', 'initial', { explain: "Two threads exist, on “repeat me” and “list item”. The cursor sits at the start of the first paragraph, above both." });
        const at = () => s.eval(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; const c = ed.getCursor(); const line = ed.getLine(c.line); return line.slice(Math.max(0, c.ch - 3), c.ch + 12); });
        s.group('Next and previous');
        await s.step('Press ⌥⌘]', async () => { await s.press('Meta+Alt+BracketRight'); await s.page.waitForTimeout(250); }, { caption: '⌥⌘] → thread 1', explain: "⌥⌘] moves the cursor to the first thread’s passage, “repeat me”, and marks its card as focused (outlined).", look: '.tg-panel .tg-card-focused, .cm-content .tg-anchor' });
        s.check('⌥⌘] puts the cursor on thread 1 (“repeat me”)', await s.cursorIn('repeat me'), await at());
        await s.step('Press ⌥⌘] again', async () => { await s.press('Meta+Alt+BracketRight'); await s.page.waitForTimeout(250); }, { caption: '⌥⌘] → thread 2', explain: "Pressed again, it moves on to thread 2, “list item”; the focus moves to its card.", look: '.tg-panel .tg-card-focused' });
        s.check('Again → thread 2 (“list item”)', await s.cursorIn('list item'), await at());
        await s.step('Press ⌥⌘[', async () => { await s.press('Meta+Alt+BracketLeft'); await s.page.waitForTimeout(250); }, { caption: '⌥⌘[ → back to thread 1', explain: "⌥⌘[ goes back to thread 1.", look: '.tg-panel .tg-card-focused' });
        s.check('⌥⌘[ goes back to thread 1', await s.cursorIn('repeat me'), await at());
        s.group('Reply at cursor');
        await s.step('Press ⌥⌘/ with the cursor inside the highlight', async () => {
          await s.press('Meta+Alt+Slash');
          await s.waitFor(() => document.activeElement?.matches('.tg-card textarea[aria-label="Reply"]'), null, { what: 'a reply box to take focus' });
        }, { caption: '⌥⌘/ → that thread’s reply box', look: '.tg-panel .tg-card textarea[aria-label="Reply"]', explain: "With the cursor inside the highlight, ⌥⌘/ puts the keyboard in that thread’s reply box (outlined), ready to answer." });
        s.equal('Focus is in the reply box of the thread under the cursor', await s.eval(() => document.activeElement?.closest('.tg-card')?.querySelector('.tg-quote')?.textContent), 'repeat me');
        s.equal('The note is unchanged', await s.read(WELCOME), welcome);
        await s.shot('End', 'final', { explain: "Where it ends: the keyboard is in thread 1’s reply box, and the note is unchanged." });
      },
    },
    {
      name: 'Search the panel with ⌘F, then jump to a passage',
      weight: 'minor',
      intro: {"headline": "This shows finding a thread by searching the panel, then jumping back to its passage.", "context": "⌘F inside the panel searches threads instead of the note; in the note, ⌘F still finds text as usual. Typing filters the cards, Esc clears the search, and ↑ or ↓ then ↩ take you from a card to its passage in the note."},
      tradeoffs: [{"option": "Panel-scoped ⌘F: the same key, scoped by where the focus is", "downside": "One key does two things; if you don’t notice where the focus is, you search the wrong place.", "chosen": true}, {"option": "A dedicated shortcut for thread search", "downside": "Unambiguous, but one more chord to learn."}, {"option": "An always-visible filter box only", "downside": "Simple, but needs a click to reach."}],
      summary: 'Pilot step 3: ⌘F in the panel focuses thread search (it does not steal ⌘F from notes), typing filters, Esc clears, ↑/↓ move between cards and ↩ jumps to the passage.',
      fixtures,
      async run(s) {
        await s.step('Open “Welcome” and comment on two passages', async () => {
          await open(s, WELCOME);
          await comment(s, 'repeat me', 'About the repeated phrase');
          await comment(s, 'formatting', 'Bold inside a list');
        }, { shot: false });
        await s.shot('Start: two threads', 'initial', { explain: "Two threads: one on “repeat me”, one on “formatting”, whose comment mentions bold." });
        s.group('⌘F');
        await s.step('Click the panel header, then press ⌘F', async () => {
          await s.page.locator('.tg-panel .tg-header-title').click();
          await s.press('Meta+F');
          await s.waitFor(() => document.activeElement?.matches('.tg-panel .tg-search'), null, { what: 'the thread search box' });
        }, { caption: '⌘F in the panel → thread search', explain: "After clicking the panel header and pressing ⌘F, the panel’s search box has the focus (outlined).", look: '.tg-panel .tg-search' });
        s.check('⌘F in the panel focuses thread search', await s.eval(() => document.activeElement?.matches('.tg-panel .tg-search')));
        s.group('Filtering');
        await s.step('Type “bold”', async () => { await s.type('bold'); await s.page.waitForTimeout(300); }, { caption: 'Only the matching thread is left', explain: "Typing “bold” leaves only the thread whose comment mentions bold.", look: '.tg-panel .tg-search, .tg-panel .tg-card:not(.tg-card-new)' });
        s.equal('Typing filters the cards', (await cards(s)).map((c) => c.quote), ['formatting']);
        await s.step('Press Esc', async () => { await s.press('Escape'); await s.page.waitForTimeout(300); }, { caption: 'Esc clears the search', explain: "Esc empties the search box, and both cards are back.", look: '.tg-panel .tg-card:not(.tg-card-new)' });
        s.equal('Esc clears the search box', await s.eval(() => document.querySelector('.tg-panel .tg-search')?.value), '');
        s.equal('Both cards are back', (await cards(s)).map((c) => c.quote), ['repeat me', 'formatting']);
        s.group('↑ ↓ ↩');
        await s.step('Click the first card, press ↓, then ↩', async () => {
          await s.page.locator('.tg-panel .tg-card .tg-card-number').first().click();
          await s.press('ArrowDown');
          await s.page.waitForTimeout(150);
          await s.press('Enter');
          await s.page.waitForTimeout(400);
        }, { caption: '↓ then ↩: the note jumps to the passage', look: '.cm-content .cm-active', explain: "Clicking the first card, then ↓ and ↩, moves the note’s cursor to the second card’s passage, “formatting” (the outlined line)." });
        const sel = await s.eval(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; const c = ed.getCursor(); return ed.getLine(c.line).slice(c.ch, c.ch + 12) + ' | ' + ed.getSelection(); });
        s.check('↩ jumps to the second card’s passage (“formatting”)', sel.includes('formatting'), sel);
        s.equal('The note is unchanged', await s.read(WELCOME), welcome);
        await s.shot('End', 'final', { explain: "Where it ends: the cursor is on “formatting” in the note, which is unchanged." });
      },
    },
    {
      name: 'Delete a comment, delete the thread, restore it',
      weight: 'major',
      intro: {"headline": "This shows deleting safely: one comment, then a whole thread, then getting it back.", "context": "In the reply box, ⌘D asks “Delete this comment?” and Enter deletes only the latest comment. ⌘⇧D deletes the whole thread after a confirmation. A “Deleted comments” section then offers Restore thread, which brings back exactly what the thread had at that moment; the comment deleted on its own stays deleted."},
      tradeoffs: [{"option": "Confirm, then delete, with a Deleted comments section to restore from", "downside": "Two safety nets cost an extra keypress and some space in the panel.", "chosen": true}, {"option": "Delete at once with a short Undo toast", "downside": "Faster, but the undo disappears after a few seconds."}, {"option": "Archive instead of delete", "downside": "Nothing is ever lost, but archived threads pile up and need cleaning."}],
      summary: 'October 1 feedback: ⌘D in the reply box deletes the latest comment after “Delete this comment?” (Enter confirms); ⌘⇧D deletes the whole thread; Deleted comments → Restore thread brings back exactly what was there.',
      fixtures,
      async run(s) {
        await s.step('Open “Welcome”, comment, and reply twice', async () => {
          await open(s, WELCOME);
          await comment(s, 'list item', 'First');
          for (const t of ['Second', 'Third']) {
            await s.type(t);
            await s.press('Meta+Enter');
            await s.waitFor((t) => [...document.querySelectorAll('.tg-panel .tg-message-body')].some((m) => m.textContent === t), t, { what: `reply “${t}”` });
          }
        }, { shot: false });
        await s.shot('Start: one thread, three comments', 'initial', { explain: "One thread on “list item”, with three comments: First, Second and Third." });
        s.group('⌘D on a comment');
        await s.step('In the reply box press ⌘D', async () => {
          await s.press('Meta+D');
          await s.waitFor(() => document.querySelector('.modal-container .modal-title')?.textContent === 'Delete this comment?', null, { what: 'the delete confirmation' });
        }, { caption: '“Delete this comment?”', explain: "⌘D in the reply box opens a confirmation (outlined) that names the comment it will delete, “Third”.", look: '.modal-container .modal' });
        s.check('The confirmation names what it deletes', (await s.eval(() => document.querySelector('.modal-container')?.innerText)).includes('Third'), await s.eval(() => document.querySelector('.modal-container')?.innerText));
        await s.step('Press Enter', async () => {
          await s.press('Enter');
          await s.waitFor(() => !document.querySelector('.modal-container'), null, { what: 'the confirmation to close' });
        }, { caption: 'The latest comment is gone', explain: "Enter confirms. Only “Third” is gone; First and Second remain (outlined).", look: '.tg-panel .tg-message-body' });
        s.equal('Only the latest comment was deleted', (await cards(s))[0]?.messages, ['First', 'Second']);
        s.group('⌘⇧D on the thread');
        await s.step('Click the card, press ⌘⇧D, confirm with Enter', async () => {
          await s.page.locator('.tg-panel .tg-card .tg-card-number').first().click();
          await s.press('Meta+Shift+D');
          await s.waitFor(() => !!document.querySelector('.modal-container'), null, { what: 'the thread delete confirmation' });
          await s.press('Enter');
          await s.waitFor(() => !document.querySelector('.tg-panel .tg-card:not(.tg-card-new)'), null, { what: 'the thread to go' });
        }, { caption: 'Thread deleted; “Deleted comments” offers Undo', explain: "⌘⇧D on the card, confirmed with Enter: the thread and its highlight are gone, and “Deleted comments” appears (outlined).", look: '.tg-panel .tg-deleted' });
        s.equal('No threads left on the note', (await cards(s)).length, 0);
        s.check('The highlight is gone from the note', !(await s.eval(() => document.querySelector('.cm-content .tg-anchor'))));
        const deleted = await s.eval(() => document.querySelector('.tg-panel .tg-deleted summary')?.textContent ?? null);
        s.check('“Deleted comments” is offered', !!deleted && deleted.startsWith('Deleted comments'), deleted);
        s.group('Restore thread');
        await s.step('Open “Deleted comments” and click Restore thread', async () => {
          await s.page.waitForTimeout(500); // let the panel finish redrawing after the delete, as a person would
          await s.page.locator('.tg-panel .tg-deleted summary').click();
          await s.waitFor(() => document.querySelector('.tg-panel .tg-deleted')?.open, null, { what: '“Deleted comments” to open' });
          await s.page.locator('.tg-panel .tg-deleted button', { hasText: 'Restore thread' }).click();
          await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === 1, null, { what: 'the thread to come back' });
        }, { caption: 'Restored with exactly the comments it had', explain: "Restore thread brings the thread back with First and Second, and the highlight returns in the note.", look: '.tg-panel .tg-card:not(.tg-card-new)' });
        s.equal('Restore brings back the two comments; “Third”, deleted on its own, stays deleted', (await cards(s))[0]?.messages, ['First', 'Second']);
        s.check('The highlight is back', await s.eval(() => document.querySelector('.cm-content .tg-anchor')?.textContent === 'list item'));
        s.equal('The note is unchanged throughout', await s.read(WELCOME), welcome);
        await s.shot('End', 'final', { explain: "Where it ends: the restored thread, and a note that never changed." });
      },
    },
    {
      name: 'A thread whose passage is deleted asks to be reattached, first',
      weight: 'major',
      intro: {"headline": "This shows what happens when the text a thread points at is deleted.", "context": "You delete the list-item sentence a thread is attached to. Its thread doesn’t vanish: it moves to the top of the panel, the header warns that one thread needs reattaching, and its card offers Reattach to selection. The other thread keeps its number."},
      tradeoffs: [{"option": "Keep the orphan, put it first, and ask you to reattach it", "downside": "It nags until handled, and sits above threads that are fine.", "chosen": true}, {"option": "Delete the thread along with its text", "downside": "Tidy, but comments vanish silently on an ordinary edit."}, {"option": "Reattach automatically to the nearest similar text", "downside": "No work for you, but it can guess wrong and attach to the wrong passage."}],
      summary: 'October 1 feedback: delete a commented passage from the note. Its thread moves to the top, the header says it needs reattaching, and the card offers Reattach to selection.',
      fixtures,
      async run(s) {
        await s.step('Open “Welcome” and comment on two passages', async () => {
          await open(s, WELCOME);
          await comment(s, 'repeat me', 'Stays');
          await comment(s, 'list item', 'Loses its passage');
        }, { shot: false });
        await s.shot('Start: two anchored threads', 'initial', { explain: "Two threads, attached to “repeat me” and “list item”." });
        await s.step('Select “A list item worth discussing.” in the note and delete it', async () => {
          await s.selectText('A list item worth discussing.');
          await s.press('Backspace');
          await s.waitFor(() => !!document.querySelector('.tg-panel .tg-header-warning'), null, { what: 'the reattach warning' });
        }, { caption: 'The orphaned thread is first, with a warning', explain: "After deleting “A list item worth discussing.”, the header warns that a thread lost its passage, and that thread is listed first with Reattach to selection (outlined).", look: '.tg-panel .tg-header-warning, .tg-panel .tg-anchor-problem, .tg-panel .tg-problem' });
        s.group('Orphaned thread');
        s.equal('Header says one thread needs reattaching', await s.eval(() => document.querySelector('.tg-panel .tg-header-warning')?.textContent), '1 thread lost its passage and needs reattaching (shown first).');
        const c = await cards(s);
        s.equal('The orphan is listed first', c.map((x) => x.messages[0]), ['Loses its passage', 'Stays']);
        s.check('Its card offers “Reattach to selection”', await s.eval(() => [...document.querySelector('.tg-panel .tg-card:not(.tg-card-new)')?.querySelectorAll('button') ?? []].some((b) => b.textContent === 'Reattach to selection')));
        s.group('Numbers');
        s.equal('The anchored thread is still numbered 1', c.find((x) => x.messages[0] === 'Stays')?.n, '1');
        s.equal('The note changed only by the deletion', await s.read(WELCOME), welcome.replace('A list item worth discussing.', ''));
        await s.shot('End', 'final', { explain: "Where it ends: the note changed only by the deletion; both threads still exist." });
      },
    },
  ],
  story: { paths: [
    { name: 'Comment on a note, find threads, tidy up', says: 'Comment with ⌘/ and ⌘↩, move between threads from the keyboard, then delete and restore.',
      steps: [
        { case: 'Comment, then a comment higher up renumbers in reading order', says: 'Select text, ⌘/, type, ⌘↩: a highlight, a number and a card.',
          edges: ['Step through threads from the keyboard', 'Search the panel with ⌘F, then jump to a passage'] },
        { case: 'Delete a comment, delete the thread, restore it', says: '⌘D deletes a comment, ⌘⇧D the thread, and Deleted comments brings it back.' },
        { case: 'A thread whose passage is deleted asks to be reattached, first', says: 'Delete the text a thread points at: the thread stays, first, asking to be reattached.' },
      ] },
  ] },
};
