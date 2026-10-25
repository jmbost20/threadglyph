/**
 * UAT: the README demo, recorded from the sandbox. The clip this scenario produces becomes
 * docs/media/demo.gif and demo.mp4 (see CONTRIBUTING.md, "The demo video"). Synthetic notes only;
 * the one request goes to Ollama on this Mac (qwen3:8b).
 */
import { ASK, aiSettings, askPlayground, cards, comment, open, threadFiles } from '../fixtures.mjs';

const fixtures = { [ASK]: askPlayground };
const aiReplies = (s) => s.eval(() => [...document.querySelectorAll('.tg-panel .tg-message')]
  .filter((m) => m.querySelector('.tg-origin')?.textContent?.startsWith('AI'))
  .map((m) => m.querySelector('.tg-message-body')?.textContent ?? ''));

const DEMO = 'The README demo: comment on a passage, then ask Local about another';

export default {
  feature: 'The README demo',
  summary: 'The demo shown in the README, played in the sandbox: a comment on one passage, then an @Local question on another, previewed, sent to Ollama on this Mac, and answered in the thread.',
  settings: aiSettings(),
  story: { paths: [
    { name: 'The demo', says: 'Comment on a passage, then ask Local about another; the answer lands in the thread.',
      steps: [{ case: DEMO, says: 'Select text, ⌘/, type, ⌘↩ for a comment; the same with “@Local …” opens a preview, and Enter sends it to Ollama on this Mac.' }] },
  ] },
  scenarios: [
    {
      name: DEMO,
      weight: 'major',
      intro: {
        headline: 'This is the README demo: a plain comment, then an Ask AI question on Local, in one sitting.',
        context: 'You comment on “Short stories” the ordinary way: select, ⌘/, type, ⌘↩. A highlight, a number and a card appear. Then you comment on “Shopping list” with “@Local …”. Nothing is sent: a preview shows who answers, “Stays on this computer”, and what goes. Enter sends it to Ollama on this Mac, and the answer is added to the thread, labelled as AI. Judge whether a stranger watching this clip understands what the plugin does.',
      },
      tradeoffs: [
        { option: 'One clip: a comment, then an Ask AI question', downside: 'Longer than a single feature, and the Ask AI half needs Ollama running.', chosen: true },
        { option: 'Comments only', downside: 'Shorter, but the privacy-first Ask AI design is the part people ask about.' },
        { option: 'Several short clips', downside: 'A README with several players is harder to skim than one.' },
      ],
      summary: 'A human comment on “Short stories”, then “@Local what is missing from this list? One short sentence.” on “Shopping list”: the preview opens with Local preselected and “Stays on this computer”; Enter sends; the reply is saved as an AI message; the note never changes.',
      review: 'Watch the clip as a stranger would. Is it clear what Threadglyph does, and that the AI question was previewed before it went anywhere?',
      fixtures,
      async run(s) {
        await s.step('Open “Ask AI playground” (⌘O)', () => open(s, ASK), { shot: false });
        await s.shot('Start: a note with no threads', 'initial', { explain: 'A synthetic note with no threads. Ask AI is switched on in settings, with Local (Ollama on this Mac) preferred.' });

        await s.step('Select “Short stories”, ⌘/, type “Add a poetry month? Two books is enough.”, ⌘↩', async () => {
          await comment(s, 'Short stories', 'Add a poetry month? Two books is enough.');
        }, { caption: 'A comment: highlight, number and card', look: '.tg-panel .tg-card:not(.tg-card-new)', explain: 'The passage is highlighted in the note with a raised number, and the comment sits in a card in the panel (outlined). The note file itself is unchanged.' });
        s.group('The comment');
        s.equal('One thread, on “Short stories”', (await cards(s)).map((c) => [c.quote, c.messages]), [['Short stories', ['Add a poetry month? Two books is enough.']]]);

        await s.step('Select “Shopping list”, ⌘/, type “@Local what is missing from this list? One short sentence.”, ⌘↩', async () => {
          await comment(s, 'Shopping list', '@Local what is missing from this list? One short sentence.');
          await s.waitFor(() => !!document.querySelector('.tg-panel .tg-ai .tg-ai-title'), null, { what: 'the Ask AI preview' });
        }, { caption: 'The preview: Local, “Stays on this computer”, and what goes', look: '.tg-panel .tg-ai', explain: 'Posting the @Local comment did not send anything. It opened this preview (outlined): Local will answer, the request stays on this computer, and the items below list what it will receive.' });
        s.group('Before sending');
        const note = await s.eval(() => document.querySelector('.tg-panel .tg-ai .tg-ai-note')?.textContent ?? '');
        s.check('The preview names Local and says it stays on this computer', note.startsWith('Local will receive the items below.') && note.includes('Stays on this computer'), note);
        s.equal('Nothing has been answered yet', (await aiReplies(s)).length, 0);

        // A person reads the preview before pressing Enter.
        await s.page.waitForTimeout(1200);
        await s.step('Press Enter to send', async () => {
          await s.press('Enter');
          await s.waitFor(() => [...document.querySelectorAll('.tg-panel .tg-origin')].some((o) => o.textContent.startsWith('AI')), null, { what: 'Local’s answer (qwen3:8b on this Mac)', timeout: 170_000 });
        }, { caption: 'Local’s answer, added to the thread and labelled AI', look: '.tg-panel .tg-card:not(.tg-card-new)', poster: true, explain: 'Enter sent the request to Ollama on this Mac. The answer is now the second message in that thread, by Local, with an “AI” label.' });
        s.group('The answer');
        const replies = await aiReplies(s);
        s.check('One AI reply in the thread', replies.length === 1 && replies[0].trim().length > 0, replies.join('\n---\n'));
        s.attach('Local’s answer', replies[0] ?? '');
        s.check('The preview has closed', !(await s.eval(() => document.querySelector('.tg-panel .tg-ai'))));
        const files = await threadFiles(s);
        s.equal('Two thread files', files.length, 2);
        const kinds = await Promise.all(files.map(async (f) => JSON.parse(await s.read(f)).messages.map((m) => [m.author.kind, m.author.name])));
        s.check('One thread is human only; the other has Local’s AI answer', kinds.some((k) => k.length === 1 && k[0][0] === 'human') && kinds.some((k) => k.length === 2 && k[1][0] === 'ai' && k[1][1] === 'Local'), JSON.stringify(kinds));
        s.group('Your note');
        s.equal('The note is byte-for-byte unchanged', await s.read(ASK), askPlayground);
        // Let the viewer take in the end state before the clip ends.
        await s.page.waitForTimeout(1500);
        await s.shot('End', 'final', { explain: 'Where it ends: two threads, one with your comment and one with your question and Local’s answer. The note itself was not touched.' });
      },
    },
  ],
};
