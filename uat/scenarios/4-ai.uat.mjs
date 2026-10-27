/**
 * UAT: Ask AI, Local first (docs/dev/pilot.md steps 5 and 6), and the @agent removal.
 * The only request sent goes to Ollama on this Mac (qwen3:8b), about synthetic text.
 * Gemini and Claude are switched on so the menus list them, but nothing is sent to them.
 */
import { ASK, aiSettings, askPlayground, cards, comment, open, threadFiles } from '../fixtures.mjs';

const fixtures = { [ASK]: askPlayground };
const aiReplies = (s) => s.eval(() => [...document.querySelectorAll('.tg-panel .tg-message')]
  .filter((m) => m.querySelector('.tg-origin')?.textContent?.startsWith('AI'))
  .map((m) => m.querySelector('.tg-message-body')?.textContent ?? ''));

export default {
  feature: 'Ask AI, Local first',
  summary: 'An @mention opens a preview of exactly what will be sent and where; nothing goes until you press Enter, and the answer lands in the thread labelled as AI.',
  settings: aiSettings(),
  scenarios: [
    {
      name: 'Ask Local about a passage: preview first, answer in the thread',
      weight: 'major',
      intro: {
        headline: 'This shows the whole Ask AI loop on Local: mention, preview, Enter, answer.',
        context: 'You comment on “Shopping list” and mention @Local. Instead of sending, Threadglyph shows a preview: who answers, “Stays on this computer”, and what goes with the request. Pressing Enter sends it to Ollama on this Mac, and the answer is added to the thread, labelled as AI. Judge whether the preview tells you enough before you send.',
      },
      tradeoffs: [
        { option: 'Preview every request; Enter sends', downside: 'One extra keypress on every question, even to a model on your own computer.', chosen: true },
        { option: 'Send straight away for Local, preview only for cloud assistants', downside: 'Faster, but a remote Ollama address or a :cloud model would slip through without a look.' },
        { option: 'Never send automatically; a separate Ask button only', downside: 'Simplest to reason about, but @mentions become decoration.' },
      ],
      summary: 'Pilot steps 5–6: “@Local …” on a list item opens the preview with Local preselected and “Stays on this computer”; Enter sends; the reply is saved as an AI message by Local; the note never changes.',
      review: 'Read the preview and the answer. Is it clear what was sent and where, and is the answer labelled clearly enough as AI?',
      fixtures,
      async run(s) {
        await s.step('Open “Ask AI playground” (⌘O)', () => open(s, ASK), { shot: false });
        await s.shot('Start: a note with no threads, Ask AI on', 'initial', { explain: 'The Ask AI playground note. Ask AI is switched on in settings, with Local (Ollama on this Mac) preferred.' });

        await s.step('Select “Shopping list”, ⌘/, type “@Local what is missing from this list? One short sentence.”, ⌘↩', async () => {
          await comment(s, 'Shopping list', '@Local what is missing from this list? One short sentence.');
          await s.waitFor(() => !!document.querySelector('.tg-panel .tg-ai .tg-ai-title'), null, { what: 'the Ask AI preview' });
        }, { caption: 'The preview: Local, “Stays on this computer”, and what goes', look: '.tg-panel .tg-ai', explain: 'Posting the comment did not send anything. It opened this preview (outlined): Local will answer, the request stays on this computer, and the items below list what it will receive.' });
        s.group('Before sending');
        const note = await s.eval(() => document.querySelector('.tg-panel .tg-ai .tg-ai-note')?.textContent ?? '');
        s.check('The preview names Local and says it stays on this computer', note.startsWith('Local will receive the items below.') && note.includes('Stays on this computer'), note);
        s.equal('Nothing has been answered yet', (await aiReplies(s)).length, 0);
        s.equal('The thread holds only your comment', (await cards(s))[0]?.messages, ['@Local what is missing from this list? One short sentence.']);

        // A person reads the preview before pressing Enter; give the panel's refresh time to settle.
        await s.page.waitForTimeout(800);
        const focus = await s.eval(() => { const a = document.activeElement; return `${a?.tagName}.${[...(a?.classList ?? [])].join('.')} in ${a?.closest('.tg-ai') ? 'the preview' : a?.closest('.tg-panel') ? 'the panel' : 'elsewhere'}`; });
        s.check('The keyboard is in the preview, ready for Enter', focus.endsWith('in the preview'), focus);
        await s.step('Press Enter to send', async () => {
          await s.press('Enter');
          await s.waitFor(() => [...document.querySelectorAll('.tg-panel .tg-origin')].some((o) => o.textContent.startsWith('AI')), null, { what: 'Local’s answer (qwen3:8b on this Mac)', timeout: 170_000 });
        }, { caption: 'Local’s answer, added to the thread and labelled AI', look: '.tg-panel .tg-card:not(.tg-card-new)', poster: true, explain: 'Enter sent the request to Ollama on this Mac. The answer is now the second message in the thread, by Local, with an “AI” label (outlined card).' });
        s.group('The answer');
        const replies = await aiReplies(s);
        s.check('One AI reply in the thread', replies.length === 1 && replies[0].trim().length > 0, replies.join('\n---\n'));
        s.attach('Local’s answer', replies[0] ?? '');
        s.check('The preview has closed', !(await s.eval(() => document.querySelector('.tg-panel .tg-ai'))));
        const [file] = await threadFiles(s);
        const record = JSON.parse(await s.read(file));
        s.equal('Saved as an AI message by Local', record.messages.map((m) => [m.author.kind, m.author.name, m.origin]), [['human', 'Me', 'human'], ['ai', 'Local', 'ai']]);
        s.group('Your note');
        s.equal('The note is byte-for-byte unchanged', await s.read(ASK), askPlayground);
        await s.shot('End', 'final', { explain: 'Where it ends: one thread with your question and Local’s answer. The note itself was not touched.' });
      },
    },
    {
      name: 'An Ollama server on another machine is labelled as leaving this computer',
      weight: 'minor',
      intro: {
        headline: 'This shows the preview telling the truth when Ollama is not on this computer.',
        context: 'In settings, the Ollama address is changed to another machine on the network (192.168.1.20). Ask AI’s preview then says “Sent to 192.168.1.20” instead of “Stays on this computer”. Nothing is sent: the request is cancelled from the preview, and no server is needed to see the label.',
      },
      tradeoffs: [
        { option: 'Judge “local” from the address: only localhost and 127.0.0.1 count', downside: 'An Ollama on your own home network is still called “sent to”, which can look alarming.', chosen: true },
        { option: 'Call every Ollama “local”', downside: 'Simpler, but untrue as soon as the address points elsewhere; this was the bug Codex found.' },
      ],
      summary: 'Pilot step 5, second half: with the Ollama address set to 192.168.1.20, the preview says “Sent to 192.168.1.20”. Esc cancels; nothing is sent.',
      settings: aiSettings({ ollamaHost: 'http://192.168.1.20:11434' }),
      fixtures,
      async run(s) {
        await s.step('Open the note and comment on “Clean the garage”', async () => {
          await open(s, ASK);
          await comment(s, 'Clean the garage', 'How long will this take?');
        }, { shot: false });
        await s.shot('Start: a thread, Ollama address set to 192.168.1.20', 'initial', { look: '.tg-panel .tg-card-footer .tg-ask', explain: 'One thread on “Clean the garage”. In settings, the Ollama address now points at another machine. The Ask AI link is at the bottom of the card (outlined).' });
        await s.step('Click “Ask AI” at the bottom of the card', async () => {
          await s.page.locator('.tg-panel .tg-card-footer .tg-ask').first().click();
          await s.waitFor(() => !!document.querySelector('.tg-panel .tg-ai .tg-ai-note'), null, { what: 'the Ask AI preview' });
        }, { caption: '“Sent to 192.168.1.20”', look: '.tg-panel .tg-ai .tg-ai-note', explain: 'The preview’s first line (outlined) now says the request would be sent to 192.168.1.20, not that it stays on this computer.' });
        s.group('The label');
        const note = await s.eval(() => document.querySelector('.tg-panel .tg-ai .tg-ai-note')?.textContent ?? '');
        s.check('The preview says “Sent to 192.168.1.20”', note.includes('Sent to 192.168.1.20') && !note.includes('Stays on this computer'), note);
        await s.step('Press Esc', async () => {
          await s.press('Escape');
          await s.waitFor(() => !document.querySelector('.tg-panel .tg-ai'), null, { what: 'the preview to close' });
        }, { caption: 'Cancelled: nothing was sent', look: '.tg-panel .tg-card:not(.tg-card-new)', explain: 'Esc closed the preview. The thread has no AI answer, because nothing was sent.' });
        s.equal('No AI reply', (await aiReplies(s)).length, 0);
        s.equal('The note is unchanged', await s.read(ASK), askPlayground);
        await s.shot('End', 'final', { explain: 'Where it ends: the thread with only your question. Nothing was sent, and the note is unchanged.' });
      },
    },
    {
      name: 'Send after the note changed shows the new preview instead of sending',
      weight: 'minor',
      intro: {
        headline: 'This shows that Send never sends text the preview did not show.',
        context: 'The preview is drawn from the note as it was. Here the note gains a line in the same section a moment before Send is pressed, too soon for the preview to redraw. Send compares the request with what the preview showed, finds a difference, sends nothing, and shows the updated preview with a note to check it. Esc then removes the question, as it would have before Send.',
      },
      tradeoffs: [
        { option: 'Check at Send and show the updated preview', downside: 'One extra press of Send when the note changed under the preview.', chosen: true },
        { option: 'Send the snapshot the preview showed', downside: 'The AI may answer about text that is no longer in the note.' },
        { option: 'Send the note as it is now', downside: 'Text you never saw in the preview can leave your computer; the audit found this.' },
      ],
      summary: 'Comment “What am I forgetting, @Local?” on “Clean the garage”, add “take old paint to the dump” to that list and press Send at once: nothing is sent, the preview shows the new line and says the note changed. Esc removes the question.',
      settings: aiSettings(),
      fixtures,
      async run(s) {
        await s.step('Open the note and comment on “Clean the garage” with “@Local”', async () => {
          await open(s, ASK);
          await comment(s, 'Clean the garage', 'What am I forgetting, @Local?');
          await s.waitFor(() => !!document.querySelector('.tg-panel .tg-ai .tg-ai-title'), null, { what: 'the Ask AI preview' });
        }, { caption: 'The preview, drawn from the note as it is', look: '.tg-panel .tg-ai', explain: 'The @Local mention opened Ask AI on the new thread (outlined). Nothing has been sent; the preview shows what Send would send.' });
        await s.step('Add a line to the list and press Send in the same moment', async () => {
          await s.eval(() => {
            const editor = app.workspace.getLeavesOfType('markdown')[0].view.editor;
            const text = editor.getValue();
            const at = text.indexOf('  - [ ] fix the shelf\n') + '  - [ ] fix the shelf\n'.length;
            editor.replaceRange('  - [ ] take old paint to the dump\n', editor.offsetToPos(at));
            document.querySelector('.tg-panel .tg-ai button.mod-cta').click();
          });
          await s.waitFor(() => !!document.querySelector('.tg-panel .tg-ai .tg-ai-error'), null, { what: 'the “note changed” notice' });
        }, { caption: 'Nothing sent: “The note changed since this preview”', look: '.tg-panel .tg-ai', explain: 'Send found that the request no longer matched the preview, so it sent nothing. The preview (outlined) now includes the new line and says to check it and send again.' });
        s.group('Send');
        s.check('The preview says the note changed', (await s.eval(() => document.querySelector('.tg-panel .tg-ai .tg-ai-error')?.textContent ?? '')) === 'The note changed since this preview. Check it and send again.');
        s.check('The card is back at the preview, not asking', await s.eval(() => document.querySelector('.tg-panel .tg-ai .tg-ai-title')?.textContent === 'Ask AI'));
        s.equal('No AI reply', (await aiReplies(s)).length, 0);
        const exact = await s.eval(async () => {
          const head = [...document.querySelectorAll('.tg-panel .tg-ai .tg-ai-group')].find((b) => b.textContent.includes('Exact text'));
          head?.click();
          await new Promise((r) => setTimeout(r, 300));
          return document.querySelector('.tg-panel .tg-ai .tg-ai-exact')?.textContent ?? '';
        });
        s.check('The updated preview shows the new line', exact.includes('take old paint to the dump'), exact.slice(0, 300));
        await s.step('Press Esc', async () => {
          await s.press('Escape');
          await s.waitFor(() => !document.querySelector('.tg-panel .tg-ai'), null, { what: 'the preview to close' });
        }, { caption: 'Cancelled: the question is removed, nothing was sent', look: '.tg-panel', explain: 'Esc closed the preview and removed the question, as it does for any preview that was never sent.' });
        s.group('After Esc');
        s.equal('No AI reply', (await aiReplies(s)).length, 0);
        s.equal('The question was removed with the preview', (await cards(s)).flatMap((c) => c.messages).filter((m) => m.includes('What am I forgetting')).length, 0);
        await s.shot('End', 'final', { explain: 'Where it ends: no answer and no question, because nothing was sent. The note keeps the line you added.' });
      },
    },
    {
      name: 'The @ menu offers Local, Gemini and Claude, and @agent is gone',
      weight: 'minor',
      intro: {
        headline: 'This shows that @agent is gone: the @ menu lists only the assistants, and no agent command remains.',
        context: '@agent, which could edit notes after Accept, was removed for 0.3.0, so Threadglyph never writes to a note. Typing @ in a reply box lists Local, Gemini and Claude with their models. The command palette, searched for “agent”, finds no agent command.',
      },
      tradeoffs: [
        { option: 'Remove @agent; the plugin never writes notes', downside: 'No way to have an AI edit the note from a comment; you copy suggestions in yourself.', chosen: true },
        { option: 'Keep @agent as a hidden, legacy feature', downside: 'A second, weaker consent path stays in a privacy-focused plugin.' },
      ],
      summary: 'The @agent removal: the @ menu shows Local, Gemini and Claude only; the palette has no agent chat or “Ask @agent” commands.',
      fixtures,
      async run(s) {
        await s.step('Open the note and comment on “Ideas”', async () => {
          await open(s, ASK);
          await comment(s, 'A few ideas', 'Any more?');
        }, { shot: false });
        await s.page.waitForTimeout(800); // as a person would, after posting
        await s.step('Type “@” in the reply box', async () => {
          await s.type('@');
          await s.page.waitForTimeout(400);
          await s.waitFor(() => document.querySelectorAll('.tg-panel .tg-mention-menu .tg-mention-option').length > 0, null, { what: 'the @ menu' });
        }, { caption: 'The @ menu: Local, Gemini, Claude', look: '.tg-panel .tg-mention-menu', explain: 'Typing @ in the reply box opens the menu (outlined). It lists the three assistants with their models. There is no @agent entry.' });
        s.group('The @ menu');
        const options = await s.eval(() => [...document.querySelectorAll('.tg-panel .tg-mention-menu .tg-mention-option')].map((o) => o.textContent));
        s.check('It lists Local, Gemini and Claude, in that order', /^@?Local/.test(options[0] ?? '') && /^@?Gemini/.test(options[1] ?? '') && /^@?Claude/.test(options[2] ?? '') && options.length === 3, options.join(' | '));
        s.check('No @agent in the menu', !options.some((o) => /agent/i.test(o)), options.join(' | '));
        await s.step('Press Esc, then open the command palette (⌘P) and type “agent”', async () => {
          await s.press('Escape');
          await s.press('Meta+P');
          await s.waitFor(() => !!document.querySelector('.prompt-input'), null, { what: 'the command palette' });
          await s.type('agent');
          await s.page.waitForTimeout(300);
        }, { caption: 'No agent command in the palette', look: '.prompt', explain: 'Searching the command palette for “agent” finds no agent command: the matches are fuzzy hits on “Threadglyph”. The old agent chat and “Ask @agent here” commands are gone. (The inline comment import appears only on a note that has that markup.)' });
        s.group('The command palette');
        const found = (await s.suggestions()).filter((t) => t.startsWith('Threadglyph'));
        s.check('No Threadglyph command in the palette has “agent” in its name', !found.some((t) => /agent/i.test(t)), found.join(' | '));
        await s.press('Escape');
        const ids = await s.eval(() => Object.keys(app.commands.commands).filter((id) => id.startsWith('threadglyph:')).sort());
        s.check('The agent commands are not registered at all', !ids.some((id) => /agent-on-line|agent-chat/.test(id)), ids.join(', '));
        s.check('The inline comment import still is', ids.includes('threadglyph:import-inline-comments'), ids.join(', '));
        s.equal('The note is unchanged', await s.read(ASK), askPlayground);
        await s.shot('End', 'final', { explain: 'Where it ends: the palette is closed, and the thread and note are as they were.' });
      },
    },
    {
      name: 'Gemini and Claude use none of your own setup (live check)',
      weight: 'minor',
      skip: 'Checked live outside Obsidian instead, last on 2026-10-27 for 0.3.1 with Gemini CLI 0.60.0 and Claude Code 2.1.311 (all 19 checks passed; first on 2026-10-25 with Claude Code 2.1.310): node scripts/check-cli-isolation.mjs gemini <Gemini folder> claude. Planted hooks, an MCP server, GEMINI.md and CLAUDE.md files with a codeword, telemetry and a bogus endpoint were all used in the control runs and none under Threadglyph\'s setup, which still got answers ("NONE"). It sends to Google and Anthropic, so it is not part of every rerun.',
      run: async () => {},
    },
    {
      name: 'Claude answers through Claude Code (cloud)',
      weight: 'minor',
      skip: 'Not run: it sends a synthetic request to Anthropic through your Claude Code sign-in. Try it yourself if you want it in the acceptance record.',
      run: async () => {},
    },
  ],
  story: { paths: [
    { name: 'Ask an assistant about a passage', says: 'Mention @Local in a comment, read the preview, press Enter, get the answer in the thread.',
      steps: [
        { case: 'Ask Local about a passage: preview first, answer in the thread', says: '@Local and ⌘↩ open a preview; Enter sends it to Ollama on this Mac.',
          edges: ['Send after the note changed shows the new preview instead of sending', 'An Ollama server on another machine is labelled as leaving this computer', 'The @ menu offers Local, Gemini and Claude, and @agent is gone'] },
      ] },
  ] },
};
