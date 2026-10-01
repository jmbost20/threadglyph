// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { openModals } from './obsidianStub';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STALE_MESSAGE, applyProposal, buildProposal, locateRegion } from '../src/agent/apply';
import { lineDiff } from '../src/agent/diff';
import { findInlineRequest, inlineTarget } from '../src/agent/inline';
import { applyEdits, applyReply, escapeRawControls, parseAgentReply, proposesChange } from '../src/agent/proposal';
import { agentTarget, listBlockAt, regionAt } from '../src/agent/target';
import { MAX_NOTE_CHARS, MAX_READ_ROUNDS, capNote, isDailyNote, rankNotes, runAgent, type AgentIo } from '../src/agent/vaultRead';
import { MAX_CONTEXT_CHARS } from '../src/ai/context';
import { AGENT_REWRITE_PROMPT, AGENT_SYSTEM_PROMPT, REWRITE_MIN_LINES, SYSTEM_PROMPT, buildPromptText, systemPromptFor } from '../src/ai/prompt';
import { agentExtraSeconds, agentPreview, buildAgentRequest, type RequestInputs } from '../src/ai/request';
import { AiSessions } from '../src/ai/session';
import type { AiAdapter, AiRequest, AiResult } from '../src/ai/types';
import { agentPreviewExtension, setAgentPreviews } from '../src/ui/agentPreview';
import { CompareModal, ConfirmSendModal, ReadPermissionModal, compareRows } from '../src/ui/modals';
import { renderDiff, renderProposal } from '../src/ui/proposalView';

const LIST = '# Shopping\n- [ ] Groceries\n  - [ ] milk\n  - [ ] apples\n- [ ] Hardware\n\n# Later\nSomething else.\n';
const block = (text: string) => `Sure.\n\`\`\`threadglyph\n${JSON.stringify(text === '' ? {} : JSON.parse(text))}\n\`\`\``;

afterEach(() => {
  document.body.innerHTML = '';
  openModals.length = 0;
});

describe('agent replies', () => {
  it('splits prose from the edits block', () => {
    const parsed = parseAgentReply(block('{"edits":[{"old":"a","new":"b"},{"old":1}]}'));
    expect(parsed).toEqual({ reply: 'Sure.', edits: [{ old: 'a', new: 'b' }], read: null });
  });

  it('treats a reply without a block, or with unreadable JSON, as a plain reply', () => {
    expect(parseAgentReply('Just words.')).toEqual({ reply: 'Just words.', edits: [], read: null });
    expect(parseAgentReply('Hi\n```threadglyph\n{nope\n```')).toEqual({ reply: 'Hi', edits: [], read: null, malformed: true });
    // An unreadable block is dropped, never passed on as reply text (it may quote the note).
    expect(parseAgentReply('```threadglyph\n{nope "milk"\n```')).toEqual({ reply: '', edits: [], read: null, malformed: true });
  });

  it('reads a whole replacement, and a block a small model labelled json (sandbox, 2026-09-30)', () => {
    const replaced = parseAgentReply('Regrouped.\n```threadglyph-replace\n- [ ] A\n  - [ ] b\n```\nDone.');
    expect(replaced).toMatchObject({ reply: 'Regrouped.\n\nDone.', edits: [], replacement: '- [ ] A\n  - [ ] b' });
    expect(proposesChange(replaced)).toBe(true);
    const labelled = parseAgentReply('Ok.\n```json\n{"edits":[{"old":"a","new":"b"}]}\n```');
    expect(labelled.edits).toEqual([{ old: 'a', new: 'b' }]);
    // Other json blocks are just part of the answer.
    expect(parseAgentReply('```json\n{"x":1}\n```').edits).toEqual([]);
    expect(proposesChange(parseAgentReply('plain'))).toBe(false);
  });

  it('takes Markdown inside a threadglyph block as the rewritten text (sandbox, 2026-09-30)', () => {
    expect(parseAgentReply('Here is the updated content:\n```threadglyph\n- [ ] A\n  - [ ] b\n```')).toEqual({
      reply: 'Here is the updated content:', edits: [], read: null, replacement: '- [ ] A\n  - [ ] b',
    });
  });

  it('applies a whole replacement, refusing an empty or unchanged one', () => {
    const reply = (replacement: string) => ({ reply: '', edits: [], read: null, replacement });
    expect(applyReply('- a\n- b\n', reply('- b\n- a\n\n'))).toEqual({ ok: true, text: '- b\n- a\n' });
    expect(applyReply('- a', reply('- b'))).toEqual({ ok: true, text: '- b' });
    expect(applyReply('- a', reply('  \n'))).toMatchObject({ ok: false, message: expect.stringContaining('empty') });
    expect(applyReply('- a\n', reply('- a'))).toMatchObject({ ok: false, noop: true });
    expect(applyReply('x y', { reply: '', edits: [{ old: 'x', new: 'z' }], read: null })).toEqual({ ok: true, text: 'z y' });
  });

  it('reads edits whose strings hold raw tabs and line breaks (qwen3:8b, sandbox 2026-10-01)', () => {
    const raw = 'Sure.\n```threadglyph\n{"edits":[{"old":"\t- [ ] a\n\t- [ ] b","new":"\t- [ ] \\"b\\"\r\n\t- [ ] a"}]}\n```';
    expect(parseAgentReply(raw)).toEqual({ reply: 'Sure.', edits: [{ old: '\t- [ ] a\n\t- [ ] b', new: '\t- [ ] "b"\r\n\t- [ ] a' }], read: null });
    expect(escapeRawControls('{"a":"x\ty"}\n')).toBe('{"a":"x\\ty"}\n');
  });

  it('takes a markdown-labelled block as the rewritten text when there is no threadglyph block', () => {
    expect(parseAgentReply('Regrouped.\n```markdown\n- [ ] A\n```')).toMatchObject({ reply: 'Regrouped.', replacement: '- [ ] A' });
    expect(parseAgentReply('```md\n- x\n```').replacement).toBe('- x');
    // A threadglyph block still wins.
    expect(parseAgentReply('```markdown\n- x\n```\n' + block('{"edits":[{"old":"a","new":"b"}]}')).edits).toHaveLength(1);
  });

  it('reads a request to see other notes', () => {
    expect(parseAgentReply(block('{"read":{"search":" pasta ","notes":["Recipes"," ",3]}}')).read).toEqual({ search: 'pasta', notes: ['Recipes'] });
    expect(parseAgentReply(block('{"read":{"search":""}}')).read).toBeNull();
    expect(parseAgentReply(block('{"read":{"notes":"x"}}')).read).toBeNull();
  });
});

describe('applying edits', () => {
  it('applies non-overlapping edits exactly once each', () => {
    expect(applyEdits('one two three', [{ old: 'three', new: '3' }, { old: 'one', new: '1' }])).toEqual({ ok: true, text: '1 two 3' });
  });

  it('adds text at the end for an empty "old"', () => {
    expect(applyEdits('- a', [{ old: '', new: '- b' }])).toEqual({ ok: true, text: '- a\n- b' });
    expect(applyEdits('- a\n', [{ old: '', new: '- b' }])).toEqual({ ok: true, text: '- a\n- b' });
    expect(applyEdits('', [{ old: '', new: 'x' }])).toEqual({ ok: true, text: 'x' });
  });

  it('refuses missing, ambiguous, overlapping, empty and no-op edits', () => {
    expect(applyEdits('abc', [{ old: 'zz', new: 'y' }])).toMatchObject({ ok: false, message: expect.stringContaining('is not there') });
    expect(applyEdits('a a', [{ old: 'a', new: 'b' }])).toMatchObject({ ok: false, message: expect.stringContaining('appears 2 times') });
    expect(applyEdits('abcd', [{ old: 'abc', new: 'x' }, { old: 'bcd', new: 'y' }])).toMatchObject({ ok: false, message: expect.stringContaining('overlapping') });
    expect(applyEdits('abc', [])).toMatchObject({ ok: false, message: expect.stringContaining('did not propose') });
    expect(applyEdits('abc', [{ old: 'b', new: 'b' }])).toMatchObject({ ok: false, noop: true, message: 'The agent found nothing to change.' });
    expect(applyEdits('x', [{ old: 'y'.repeat(80), new: '' }])).toMatchObject({ ok: false, message: expect.stringContaining('…') });
  });
});

describe('long quotes that are not word for word', () => {
  const base = ['- [ ] Head', '  - [ ] one', '  - [ ] two', '  - [ ] three', '  - [ ] four', '- [ ] Tail'].join('\n');
  const drifted = ['  - [ ] one', '  - [ ] TWO (misquoted)', '  - [ ] three', '  - [ ] four'].join('\n');

  it('matches them by their first and last lines, and says so', () => {
    expect(applyEdits(base, [{ old: drifted, new: '  - [ ] all' }])).toEqual({ ok: true, text: '- [ ] Head\n  - [ ] all\n- [ ] Tail', loose: true });
    const built = buildProposal('n.md', regionAt(base, 0, base.length, 'All'), { reply: '', edits: [{ old: drifted, new: '  - [ ] all' }], read: null });
    expect(built.ok && built.proposal.loose).toBe(true);
  });

  it('still refuses short quotes, unclear ends, and spans of a very different length', () => {
    expect(applyEdits(base, [{ old: '  - [ ] one\n  - [ ] TWO', new: 'x' }])).toMatchObject({ ok: false });
    expect(applyEdits(`${base}\n  - [ ] one`, [{ old: drifted, new: 'x' }])).toMatchObject({ ok: false });
    expect(applyEdits(base, [{ old: ['  - [ ] four', 'x', '  - [ ] one'].join('\n'), new: 'x' }])).toMatchObject({ ok: false });
    const padded = ['  - [ ] one', 'y'.repeat(400), '  - [ ] four'].join('\n');
    expect(applyEdits(base, [{ old: padded, new: 'x' }])).toMatchObject({ ok: false });
  });
});

describe('line diff', () => {
  it('shows a reorder as removed and added lines around what stayed', () => {
    expect(lineDiff('a\nb\nc', 'b\nc\na')).toEqual([
      { kind: 'remove', text: 'a' },
      { kind: 'same', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'a' },
    ]);
  });

  it('shows inserts and deletes', () => {
    expect(lineDiff('a\nc', 'a\nb\nc').filter((d) => d.kind !== 'same')).toEqual([{ kind: 'add', text: 'b' }]);
    expect(lineDiff('a\nb', 'a').filter((d) => d.kind !== 'same')).toEqual([{ kind: 'remove', text: 'b' }]);
  });
});

describe('what the agent may change', () => {
  it('takes a list item with everything nested under it', () => {
    const at = LIST.indexOf('Groceries');
    const range = listBlockAt(LIST, at)!;
    expect(LIST.slice(range.from, range.to)).toBe('- [ ] Groceries\n  - [ ] milk\n  - [ ] apples');
    expect(listBlockAt(LIST, 0)).toBeNull();
  });

  it('chooses the list block, the passage lines, the section or the note by scope', () => {
    const at = LIST.indexOf('Groceries');
    expect(agentTarget(LIST, at, at + 9, 'anchor')).toMatchObject({ text: '- [ ] Groceries\n  - [ ] milk\n  - [ ] apples', label: 'The list item and everything under it' });
    const plain = LIST.indexOf('else');
    expect(agentTarget(LIST, plain, plain + 4, 'anchor')).toMatchObject({ text: 'Something else.', label: 'The lines of the passage' });
    expect(agentTarget(LIST, at, at, 'anchor').text).toContain('Groceries');
    expect(agentTarget(LIST, at, at + 9, 'section')).toMatchObject({ label: 'The section “Shopping”', text: '# Shopping\n- [ ] Groceries\n  - [ ] milk\n  - [ ] apples\n- [ ] Hardware' });
    expect(agentTarget(LIST, at, at + 9, 'note')).toMatchObject({ from: 0, text: LIST.trimEnd() });
    // A passage running past its list item takes whole lines instead.
    expect(agentTarget(LIST, at, LIST.indexOf('Hardware') + 3, 'anchor').label).toBe('The lines of the passage');
  });
});

describe('proposals', () => {
  const region = agentTarget(LIST, LIST.indexOf('Groceries'), LIST.indexOf('Groceries') + 9, 'anchor');
  const sort = { reply: 'Sorted.', read: null, edits: [{ old: '  - [ ] milk\n  - [ ] apples', new: '  - [ ] apples\n  - [ ] milk' }] };

  it('builds a checked proposal with its diff, or says why not', () => {
    const built = buildProposal('n.md', region, sort);
    expect(built.ok && built.proposal.result).toBe('- [ ] Groceries\n  - [ ] apples\n  - [ ] milk');
    expect(built.ok && built.proposal.diff.some((d) => d.kind === 'add')).toBe(true);
    expect(buildProposal('n.md', region, { ...sort, edits: [{ old: 'nope', new: '' }] })).toMatchObject({ ok: false });
  });

  it('finds its text again after lines above it changed, and refuses when it changed', () => {
    expect(locateRegion(LIST, region)).toBe(region.from);
    expect(locateRegion(`New line\n${LIST}`, region)).toBe(region.from + 9);
    expect(locateRegion(LIST.replace('milk', 'oat milk'), region)).toBeNull();
    // With its old place gone, a text that appears twice is ambiguous.
    expect(locateRegion(`${LIST}\n${region.text}`, { ...region, before: undefined, after: undefined, from: 1, to: 2 })).toBeNull();
    expect(locateRegion(`${LIST}\n${region.text}`, { ...region, from: 1, to: 2 })).toBe(region.from);
    expect(locateRegion('x', { from: 5, to: 5, text: '', label: '' })).toBeNull();
  });

  it('never moves onto another copy of the text when the original was edited (Gitar PR #10)', () => {
    const twice = `${LIST}\n# Copy\n- [ ] Groceries\n  - [ ] milk\n  - [ ] apples\n`;
    const at = twice.indexOf('Groceries');
    const target = agentTarget(twice, at, at + 9, 'anchor');
    const edited = twice.replace('  - [ ] milk', '  - [ ] oat milk');
    expect(edited.indexOf(target.text)).toBeGreaterThan(target.from);
    expect(locateRegion(edited, target)).toBeNull();
    // Moving the untouched original (text added above) still finds it.
    expect(locateRegion(`Top\n${twice}`, target)).toBe(target.from + 4);
  });

  it('applies as one editor transaction, and only if the text is unchanged', () => {
    const built = buildProposal('n.md', region, sort);
    if (!built.ok) throw new Error('expected a proposal');
    let doc = LIST;
    const editor = {
      getValue: () => doc,
      offsetToPos: (offset: number) => ({ offset }),
      transaction: vi.fn((tx: { changes: { from: { offset: number }; to: { offset: number }; text: string }[] }) => {
        const [c] = tx.changes;
        doc = doc.slice(0, c.from.offset) + c.text + doc.slice(c.to.offset);
      }),
    };
    expect(applyProposal(editor as never, built.proposal)).toEqual({ ok: true });
    expect(editor.transaction).toHaveBeenCalledTimes(1);
    expect(doc).toBe(LIST.replace('milk\n  - [ ] apples', 'apples\n  - [ ] milk'));
    expect(applyProposal(editor as never, built.proposal)).toEqual({ ok: false, message: STALE_MESSAGE });
    expect(editor.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('inline requests', () => {
  const doc = '# Shopping\n- [ ] Groceries @agent sort these\n  - [ ] milk\n  - [ ] apples\n';

  it('finds the request on the cursor line and what to remove', () => {
    const request = findInlineRequest(doc, doc.indexOf('sort'))!;
    expect(request.instruction).toBe('sort these');
    expect(doc.slice(request.removeFrom, request.removeTo)).toBe(' @agent sort these');
    expect(findInlineRequest(doc, 2)).toBeNull();
    expect(findInlineRequest('email me@agent.com', 3)).toBeNull();
  });

  it('removes a line that holds only the request, with one line break', () => {
    const own = 'Intro\n- @agent add three ideas\nOutro';
    const request = findInlineRequest(own, own.indexOf('add'))!;
    expect(own.slice(request.removeFrom, request.removeTo)).toBe('- @agent add three ideas\n');
    const last = 'Intro\n@agent add ideas';
    const end = findInlineRequest(last, last.length)!;
    expect(last.slice(end.removeFrom, end.removeTo)).toBe('\n@agent add ideas');
  });

  it('targets the list item under the request, which the agent sees without the request', () => {
    const { region, base } = inlineTarget(doc, findInlineRequest(doc, doc.indexOf('sort'))!);
    expect(base).toBe('- [ ] Groceries\n  - [ ] milk\n  - [ ] apples');
    expect(region.text).toBe('- [ ] Groceries @agent sort these\n  - [ ] milk\n  - [ ] apples');
    expect(region.label).toBe('The list item and everything under it');
  });

  it('targets the section around a request on its own line', () => {
    const own = '# Ideas\nFirst.\n@agent add two more\n# Next\nx';
    const { region, base } = inlineTarget(own, findInlineRequest(own, own.indexOf('add'))!);
    expect(base).toBe('# Ideas\nFirst.\n');
    expect(region.text).toBe('# Ideas\nFirst.\n@agent add two more\n');
    expect(region.label).toBe('The section “Ideas”');
  });
});

describe('reading other notes', () => {
  it('recognises daily notes', () => {
    expect(isDailyNote('Daily/2026-09-28.md')).toBe(true);
    expect(isDailyNote('2026-09-28 thoughts.md')).toBe(true);
    expect(isDailyNote('journal/x.md')).toBe(true);
    expect(isDailyNote('Projects/Recipes.md')).toBe(false);
  });

  it('ranks matches, skips daily notes and caps length', () => {
    const notes = [
      { path: 'Daily/2026-09-28.md', text: 'pasta pasta pasta' },
      { path: 'Recipes.md', text: 'pasta and more pasta' },
      { path: 'Travel.md', text: 'pasta once' },
      { path: 'Other.md', text: 'nothing' },
    ];
    expect(rankNotes('pasta', notes).map((n) => n.path)).toEqual(['Recipes.md', 'Travel.md']);
    expect(rankNotes('a', notes)).toEqual([]);
    expect(capNote('x', 'y'.repeat(MAX_NOTE_CHARS + 5)).text).toMatch(/\[…truncated\]$/);
  });

  const asking = (answers: AiResult[]) => {
    const requests: AiRequest[] = [];
    const adapter: AiAdapter = {
      id: 'local', name: 'Local', detail: 'm', egress: 'local', capabilities: { text: true, images: false },
      ask: async (request) => {
        requests.push(request);
        return answers.shift() ?? { ok: true, text: 'done' };
      },
    };
    return { adapter, requests };
  };
  const readAsk = { ok: true as const, text: block('{"read":{"notes":["Recipes"]}}') };
  const request: AiRequest = { noteName: 'n', quote: null, image: null, context: null, messages: [] };

  it('reads nothing when the user denies', async () => {
    const { adapter, requests } = asking([readAsk]);
    const io: AgentIo = { askPermission: vi.fn(async () => false), readNotes: vi.fn(async () => []) };
    const result = await runAgent(adapter, request, new AbortController().signal, io);
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('did not let it read') });
    expect(io.readNotes).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('asks again with the allowed notes, up to the round limit', async () => {
    const { adapter, requests } = asking([readAsk, { ok: true, text: block('{"read":{"search":"more"}}') }, readAsk]);
    let n = 0;
    const io: AgentIo = { askPermission: async () => true, readNotes: async () => [{ path: `N${++n}.md`, text: 't' }] };
    const result = await runAgent(adapter, request, new AbortController().signal, io);
    expect(requests).toHaveLength(MAX_READ_ROUNDS + 1);
    expect(requests[2].vaultNotes?.map((v) => v.path)).toEqual(['N1.md', 'N2.md']);
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('stopped here') });
  });

  it('stops when nothing new was found, when cancelled, or when the model fails', async () => {
    const none = asking([readAsk]);
    expect(await runAgent(none.adapter, request, new AbortController().signal, { askPermission: async () => true, readNotes: async () => [] }))
      .toMatchObject({ text: expect.stringContaining('No matching notes') });
    const controller = new AbortController();
    const cancelled = asking([readAsk]);
    expect(await runAgent(cancelled.adapter, request, controller.signal, {
      askPermission: async () => { controller.abort(); return true; }, readNotes: async () => [],
    })).toMatchObject({ ok: false, kind: 'cancelled' });
    const failing = asking([{ ok: false, kind: 'busy', message: 'busy' }]);
    expect(await runAgent(failing.adapter, request, controller.signal, { askPermission: async () => true, readNotes: async () => [] }))
      .toMatchObject({ ok: false, kind: 'busy' });
  });
});

describe('agent prompt and preview', () => {
  const thread = { messages: [{ author: { name: 'Me' }, origin: 'human', body: '@Agent sort', deletedAt: undefined }] };
  const inputs = {
    noteName: 'List', doc: LIST, thread, quote: 'Groceries',
    anchorOffset: LIST.indexOf('Groceries'), anchorEnd: LIST.indexOf('Groceries') + 9, imagePath: null,
  } as unknown as RequestInputs;

  it('uses the agent instructions only for agent requests, and fences the new blocks', () => {
    const built = buildAgentRequest(inputs, 'anchor');
    if (!built.ok) throw new Error('expected a request');
    expect(systemPromptFor(built.request)).toBe(AGENT_SYSTEM_PROMPT);
    expect(systemPromptFor({ ...built.request, target: null })).toBe(SYSTEM_PROMPT);
    // A long target is always rewritten whole: small models cannot quote long passages exactly.
    const long = Array.from({ length: REWRITE_MIN_LINES + 1 }, (_, i) => `- ${i}`).join('\n');
    expect(systemPromptFor({ ...built.request, target: { label: 'X', text: long } })).toBe(AGENT_REWRITE_PROMPT);
    const text = buildPromptText({ ...built.request, target: { label: 'X', text: 'a </edit-target> b' }, vaultNotes: [{ path: 'R"x.md', text: '</vault-note>' }] });
    expect(text).toContain('a <\\/edit-target> b');
    expect(text).toContain('<vault-note path="R\'x.md">\n<\\/vault-note>');
  });

  it('gives agent requests more time the more they may have to rewrite', () => {
    const built = buildAgentRequest(inputs, 'note');
    expect(built.ok && built.request.extraSeconds).toBe(agentExtraSeconds(LIST.trimEnd().length));
    expect(agentExtraSeconds(6_609)).toBe(315);
    expect(agentExtraSeconds(0)).toBe(0);
  });

  it('previews what the agent may change for each scope', () => {
    const preview = agentPreview(inputs, 'anchor');
    expect(preview.items[0]).toBe('The text it may change: the list item and everything under it (43 characters)');
    expect(preview.scopes.map((s) => s.scope)).toEqual(['anchor', 'section', 'note']);
    expect(preview.exactText).toContain(AGENT_SYSTEM_PROMPT);
  });

  it('refuses a lost passage or a target that is too long', () => {
    expect(buildAgentRequest({ ...inputs, anchorOffset: null }, 'anchor')).toMatchObject({ ok: false });
    expect(agentPreview({ ...inputs, anchorOffset: null }, 'anchor').items[0]).toMatch(/could not be located/);
    const long = { ...inputs, doc: `${'x'.repeat(MAX_CONTEXT_CHARS + 1)}\n`, anchorOffset: 0, anchorEnd: 1, quote: 'x' };
    expect(buildAgentRequest(long as RequestInputs, 'note')).toMatchObject({ ok: false, message: expect.stringContaining('too long') });
    expect(agentPreview(long as RequestInputs, 'note').scopes[2].label).toContain('unavailable');
    expect(buildAgentRequest({ ...inputs, anchorEnd: undefined }, 'anchor').ok).toBe(true);
  });

  it('keeps the agent flag through cancel and a change of assistant', () => {
    const sessions = new AiSessions(() => {});
    sessions.open('t', 'local', true);
    expect(sessions.get('t')).toMatchObject({ agent: true, scope: 'anchor' });
    sessions.setAssistant('t', 'gemini');
    sessions.cancel('t');
    expect(sessions.get('t')).toMatchObject({ agent: true, assistant: 'gemini' });
    sessions.open('t', 'local', false);
    expect(sessions.get('t')?.agent).toBeUndefined();
  });
});

describe('proposal views', () => {
  it('folds long unchanged stretches of a diff', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const box = renderDiff(document.body, lineDiff(before, before.replace('g', 'G').replace('a', 'A')));
    expect([...box.children].map((c) => c.textContent)).toEqual(['−a', '+A', ' b', ' c', '…', ' e', ' f', '−g', '+G']);
  });

  it('offers Accept and Reject, or only Dismiss for an error', () => {
    const accept = vi.fn();
    const reject = vi.fn();
    const box = renderProposal(document.body, { key: 'k', reply: 'Why', diff: lineDiff('a', 'b'), error: null }, accept, reject);
    const buttons = [...box.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Reject', 'Accept']);
    buttons[1].click();
    expect(accept).toHaveBeenCalled();
    expect(buttons[1].disabled).toBe(true);
    const failed = renderProposal(document.body, { key: 'k', reply: '', diff: null, error: 'Nope' }, accept, reject);
    expect([...failed.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Dismiss']);
    expect(failed.querySelector('.tg-ai-error')?.textContent).toBe('Nope');
  });

  it('draws a proposal under its text in the editor, with working buttons', () => {
    const actions = { accept: vi.fn(), reject: vi.fn(), compare: vi.fn() };
    const view = new EditorView({ state: EditorState.create({ doc: LIST, extensions: [agentPreviewExtension(actions)] }), parent: document.body });
    const region = agentTarget(LIST, LIST.indexOf('Groceries'), LIST.indexOf('Groceries') + 9, 'anchor');
    const diff = lineDiff(region.text, region.text.replace('milk', 'oat milk'));
    view.dispatch({ effects: setAgentPreviews.of([
      { key: 'k', from: region.from, to: region.to, diff },
      { key: 'bad', from: -1, to: 3, diff },
      { key: 'empty', from: 0, to: 0, diff: [] },
    ]) });
    const widgets = view.dom.querySelectorAll<HTMLElement>('.tg-inline-proposal');
    expect(widgets).toHaveLength(2);
    const widget = view.dom.querySelector<HTMLElement>('.tg-inline-proposal[data-proposal="k"]')!;
    expect([...widget.querySelectorAll('.tg-inline-add')].map((e) => e.textContent)).toEqual(['+   - [ ] oat milk']);
    expect([...widget.querySelectorAll('.tg-inline-remove')].map((e) => e.textContent)).toEqual(['−   - [ ] milk']);
    expect(view.dom.querySelector('.tg-agent-target')).not.toBeNull();
    const [compare, reject, accept] = [...widget.querySelectorAll('button')];
    compare.click();
    expect(actions.compare).toHaveBeenCalledWith('k');
    reject.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    accept.click();
    reject.click();
    expect(actions.accept).toHaveBeenCalledWith('k');
    expect(actions.reject).toHaveBeenCalledWith('k');
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(view.dom.querySelector('.tg-inline-proposal')).not.toBeNull();
    view.destroy();
  });
});

describe('in-note diff', () => {
  it('folds long unchanged stretches around the change', () => {
    const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const doc = `${before}\n`;
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [agentPreviewExtension({ accept: vi.fn(), reject: vi.fn(), compare: vi.fn() })] }), parent: document.body });
    view.dispatch({ effects: setAgentPreviews.of([{ key: 'k', from: 0, to: before.length, diff: lineDiff(before, before.replace('line 9', 'line nine')) }]) });
    const rows = [...view.dom.querySelectorAll('.tg-inline-line')].map((e) => e.textContent);
    expect(rows).toEqual(['…', '  line 7', '  line 8', '− line 9', '+ line nine', '  line 10', '  line 11']);
    view.destroy();
  });
});

describe('side-by-side compare', () => {
  it('faces each removed run with the lines that replaced it', () => {
    expect(compareRows(lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne'))).toEqual([
      { before: 'a', after: 'a', kind: 'same' },
      { before: 'b', after: 'B', kind: 'change' },
      { before: 'c', after: 'c', kind: 'same' },
      { before: 'd', after: 'd', kind: 'same' },
      { before: null, after: 'e', kind: 'change' },
    ]);
    expect(compareRows(lineDiff('x\ny', 'x'))).toEqual([{ before: 'x', after: 'x', kind: 'same' }, { before: 'y', after: null, kind: 'change' }]);
  });

  it('shows Original and Proposed columns with changes marked', () => {
    const modal = new CompareModal({} as never, lineDiff('keep\nold', 'keep\nnew'));
    modal.open();
    const cells = [...modal.contentEl.querySelectorAll<HTMLElement>('.tg-compare > div')].map((c) => `${c.className.replace(/tg-compare-(cell|before|after) ?/g, '').trim()}|${c.textContent}`);
    expect(cells).toEqual(['tg-compare-head|Original', 'tg-compare-head|Proposed', '|keep', '|keep', 'tg-compare-removed|old', 'tg-compare-added|new']);
    modal.close();
    const empty = new CompareModal({} as never, lineDiff('a', 'a\nb'));
    empty.open();
    expect(empty.contentEl.querySelector('.tg-compare-empty')).not.toBeNull();
  });
});

describe('agent dialogs', () => {
  it('asks before reading other notes; closing counts as Deny', () => {
    const decide = vi.fn();
    const modal = new ReadPermissionModal({} as never, {
      search: 'pasta',
      notes: [{ name: 'Recipes', path: 'Recipes.md', daily: false }, { name: 'Today', path: 'Daily/2026-09-28.md', daily: true }, { name: 'Gone', path: null, daily: false }],
      destination: 'Sent to Google',
      cloud: true,
    }, decide);
    modal.open();
    const text = modal.contentEl.textContent!;
    expect(text).toContain('Search your notes for “pasta”');
    expect(text).toContain('daily note');
    expect(text).toContain('Gone (not found, will be skipped)');
    expect(text).toContain('will leave this computer');
    expect(document.activeElement?.textContent).toBe('Deny');
    modal.close();
    expect(decide).toHaveBeenCalledWith(false);
    expect(decide).toHaveBeenCalledTimes(1);

    const local = vi.fn();
    const allow = new ReadPermissionModal({} as never, { search: null, notes: [], destination: 'Stays on this computer', cloud: false }, local);
    allow.open();
    [...allow.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Allow')!.click();
    expect(local).toHaveBeenCalledWith(true);
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('confirms a send to a cloud assistant', () => {
    const decide = vi.fn();
    const modal = new ConfirmSendModal({} as never, 'The section', 'Sent to Google', decide);
    modal.open();
    expect(modal.contentEl.textContent).toContain('The section will be sent. Sent to Google.');
    [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click();
    expect(decide).toHaveBeenCalledWith(true);
    const declined = vi.fn();
    const other = new ConfirmSendModal({} as never, 'x', 'y', declined);
    other.open();
    [...other.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
    expect(declined).toHaveBeenCalledWith(false);
  });
});
