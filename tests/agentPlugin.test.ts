// @vitest-environment happy-dom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FakeApp, notices, openModals, type MarkdownView } from './obsidianStub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadglyphPlugin, { mentionsAgent } from '../src/main';
import type { AiAdapter, AiRequest, AiResult } from '../src/ai/types';
import { THREADS_DIR } from '../src/storage/paths';
import type { AgentSuggest } from '../src/ui/agentSuggest';
import { AgentAskModal } from '../src/ui/agentAskModal';
import { AGENT_LEGACY_NOTE } from '../src/ui/proposalView';

type Fake = InstanceType<typeof FakeApp>;
type Editor = MarkdownView['editor'] & { selection: [number, number]; cm?: EditorView; transactions: unknown[][] };

const NOTE = 'Projects/Shopping.md';
const NOTE_TEXT = '# Shopping\n- [ ] Groceries\n  - [ ] milk\n  - [ ] apples\n- [ ] Hardware\n\n# Later\nSomething else.\n';
const SORTED = NOTE_TEXT.replace('milk\n  - [ ] apples', 'apples\n  - [ ] milk');
const SORT_ANSWER = [
  'Sorted the groceries alphabetically.',
  '```threadglyph',
  JSON.stringify({ edits: [{ old: '  - [ ] milk\n  - [ ] apples', new: '  - [ ] apples\n  - [ ] milk' }] }),
  '```',
].join('\n');

let app: Fake;
let plugin: ThreadglyphPlugin;
let view: MarkdownView & { editor: Editor };
let requests: AiRequest[];
let answers: AiResult[];
let egress: 'local' | 'cloud';
/** While set, the assistant waits for it before answering. */
let hold: Promise<void> | null;

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const note = () => app.vault.adapter.files.get(NOTE)!;
const threadFiles = () => [...app.vault.adapter.files.entries()].filter(([p]) => p.startsWith(`${THREADS_DIR}/`)).map(([, v]) => v);
const panelEl = () => document.querySelector<HTMLElement>('.tg-panel:not(.tg-chat)')!;
const chatEl = () => document.querySelector<HTMLElement>('.tg-chat')!;
const buttonIn = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const command = (id: string) =>
  (plugin as unknown as { commands: { id: string; editorCheckCallback?: (...a: unknown[]) => boolean; callback?: () => unknown }[] }).commands.find((c) => c.id === id)!;
const panelProposals = () => Object.fromEntries(plugin.agents.forNote(NOTE).map((e) => [e.key, e]));
const suggest = () => (plugin as unknown as { suggests: AgentSuggest[] }).suggests[0];

async function commentOn(text: string, body: string) {
  const from = note().indexOf(text);
  view.editor.selection = [from, from + text.length];
  command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
  await flush();
  const input = panelEl().querySelector<HTMLTextAreaElement>('.tg-card-new textarea')!;
  input.value = body;
  input.dispatchEvent(new Event('input'));
  buttonIn(panelEl(), 'Comment')!.click();
  await flush();
}

/** Shows the editor the current note text, as Obsidian's editor would. */
function syncEditor() {
  view.editor.cm?.destroy();
  view.editor.cm = new EditorView({
    state: EditorState.create({ doc: note(), extensions: (plugin as unknown as { extensions: Extension[] }).extensions }),
    parent: document.body,
  });
}

beforeEach(async () => {
  notices.length = 0;
  openModals.length = 0;
  requests = [];
  answers = [];
  egress = 'local';
  hold = null;
  app = new FakeApp();
  app.vault.adapter.files.set(NOTE, NOTE_TEXT);
  app.vault.adapter.files.set('Recipes.md', 'Pasta: boil, salt, drain.\n');
  app.vault.adapter.files.set('Italian.md', 'Fresh pasta needs eggs.\n');
  app.vault.adapter.files.set('Hiking.md', 'Boots and water.\n');
  app.vault.adapter.files.set('Daily/2026-09-28.md', 'Private: had pasta with a friend.\n');
  view = app.workspace.open(NOTE) as typeof view;
  plugin = new ThreadglyphPlugin(app as never, {} as never);
  const adapter: AiAdapter = {
    id: 'local',
    name: 'Local',
    detail: 'qwen3:8b',
    get egress() {
      return egress;
    },
    capabilities: { text: true, images: true },
    ask: async (request) => {
      requests.push(request);
      if (hold) await hold;
      return answers.shift() ?? { ok: true, text: 'No change needed.' };
    },
  };
  plugin.adapterFactory = (settings) => (settings.aiEnabled ? [adapter] : []);
  await plugin.onload();
  plugin.settings.aiEnabled = true;
  await flush();
  syncEditor();
  await plugin.refresh();
});

afterEach(() => {
  plugin.onunload();
  view.editor.cm?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('@Agent in a comment', () => {
  async function propose() {
    await commentOn('Groceries', '@Agent sort the children alphabetically');
    expect(panelEl().querySelector('.tg-ai-title')?.textContent).toBe('Ask the agent to change the note');
    expect(panelEl().querySelector('.tg-legacy')?.textContent).toBe(AGENT_LEGACY_NOTE);
    panelEl().querySelector<HTMLElement>('.tg-ai-group[data-row="scope"]')!.click();
    expect(panelEl().querySelector('.tg-ai-items li')?.textContent).toBe(
      'The text it may change: the list item and everything under it (43 characters)');
    expect(requests).toHaveLength(0);
    answers.push({ ok: true, text: SORT_ANSWER });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
  }

  it('shows the change and writes nothing until Accept; Accept applies it as one edit', async () => {
    await propose();
    expect(requests[0].target).toEqual({ label: 'The list item and everything under it', text: '- [ ] Groceries\n  - [ ] milk\n  - [ ] apples' });
    expect(note()).toBe(NOTE_TEXT);
    expect(view.editor.transactions).toHaveLength(0);

    const box = panelEl().querySelector<HTMLElement>('.tg-proposal')!;
    expect([...box.querySelectorAll('.tg-diff-add')].map((e) => e.textContent)).toEqual(['+  - [ ] milk']);
    expect(view.editor.cm!.dom.querySelector('.tg-inline-proposal')).not.toBeNull();
    const reply = [...panelEl().querySelectorAll('.tg-message')].at(-1)!;
    expect(reply.textContent).toContain('Local (agent)');
    expect(reply.textContent).toContain('Sorted the groceries alphabetically.');
    // The proposal holds note text, so it is never saved with the thread.
    expect(threadFiles().join()).not.toContain('apples');
    expect(threadFiles().join()).not.toContain('threadglyph');

    buttonIn(box, 'Accept')!.click();
    await flush();
    expect(note()).toBe(SORTED);
    expect(view.editor.transactions).toHaveLength(1);
    expect(panelEl().querySelector('.tg-proposal')).toBeNull();
    expect(notices.at(-1)).toContain('Undo');
  });

  it('says a local rewrite can take minutes while it runs', async () => {
    await commentOn('Groceries', '@Agent regroup');
    vi.spyOn(plugin.adapterFactory(plugin.settings)[0], 'ask').mockImplementation(() => new Promise(() => {}));
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    expect(panelEl().querySelector('.tg-ai-phase-running .tg-ai-note')?.textContent).toContain('can take a few minutes');
  });

  it('leaves the note untouched on Reject', async () => {
    await propose();
    buttonIn(panelEl().querySelector('.tg-proposal')!, 'Reject')!.click();
    await flush();
    expect(note()).toBe(NOTE_TEXT);
    expect(view.editor.transactions).toHaveLength(0);
    expect(panelEl().querySelector('.tg-proposal')).toBeNull();
  });

  it('refuses a proposal once the note changed under it', async () => {
    await propose();
    app.vault.adapter.files.set(NOTE, NOTE_TEXT.replace('milk', 'oat milk'));
    buttonIn(panelEl().querySelector('.tg-proposal')!, 'Accept')!.click();
    await flush();
    expect(note()).toBe(NOTE_TEXT.replace('milk', 'oat milk'));
    expect(panelEl().querySelector('.tg-proposal .tg-ai-error')?.textContent).toContain('The note changed');
    buttonIn(panelEl().querySelector('.tg-proposal')!, 'Dismiss')!.click();
    await flush();
    expect(panelEl().querySelector('.tg-proposal')).toBeNull();
  });

  it('marks a proposal stale when the note is edited before Accept', async () => {
    await propose();
    app.vault.adapter.files.set(NOTE, NOTE_TEXT.replace('apples', 'pears'));
    await plugin.refresh();
    expect(panelEl().querySelector('.tg-proposal .tg-ai-error')?.textContent).toContain('The note changed');
    expect(buttonIn(panelEl().querySelector('.tg-proposal')!, 'Accept')).toBeUndefined();
  });

  it('opens the note to apply a change, and explains when the note is gone', async () => {
    await propose();
    app.workspace.leaves = app.workspace.leaves.filter((l) => l !== view.leaf);
    buttonIn(panelEl().querySelector('.tg-proposal')!, 'Accept')!.click();
    await flush();
    expect(note()).toBe(SORTED);

    await commentOn('Hardware', '@Agent make it bold');
    answers.push({ ok: true, text: '```threadglyph\n{"edits":[{"old":"Hardware","new":"**Hardware**"}]}\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    app.vault.adapter.files.delete(NOTE);
    await plugin.agents.accept(Object.keys(panelProposals())[0]);
    expect(notices.at(-1)).toBe('Open the note to apply this change.');
  });

  it('says why an edit that does not match the note cannot be applied', async () => {
    await commentOn('Groceries', '@Agent tidy');
    answers.push({ ok: true, text: '```threadglyph\n{"edits":[{"old":"bananas","new":"x"}]}\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    expect(panelEl().querySelector('.tg-proposal .tg-ai-error')?.textContent).toContain('“bananas” is not there');
    expect([...panelEl().querySelectorAll('.tg-message')].at(-1)!.textContent).toContain('Proposed a change to the note.');
  });

  it('shows a whole-block rewrite as a proposal and applies it on Accept', async () => {
    await commentOn('Groceries', '@Agent regroup');
    answers.push({ ok: true, text: 'Regrouped.\n```threadglyph-replace\n- [ ] Groceries\n  - [ ] Dairy: milk\n  - [ ] Fruit: apples\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    expect(requests[0].extraSeconds).toBe(45);
    expect(note()).toBe(NOTE_TEXT);
    buttonIn(panelEl().querySelector('.tg-proposal')!, 'Accept')!.click();
    await flush();
    expect(note()).toBe(NOTE_TEXT.replace('  - [ ] milk\n  - [ ] apples', '  - [ ] Dairy: milk\n  - [ ] Fruit: apples'));
    expect(threadFiles().join()).not.toContain('Dairy');
  });

  it('treats edits that change nothing as an answer, not a proposal', async () => {
    await commentOn('Groceries', '@Agent sort these');
    answers.push({ ok: true, text: 'Already sorted.\n```threadglyph\n{"edits":[{"old":"milk","new":"milk"}]}\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    expect(panelEl().querySelector('.tg-proposal')).toBeNull();
    expect([...panelEl().querySelectorAll('.tg-message')].at(-1)!.textContent).toContain('Already sorted.');

    await commentOn('Hardware', '@Agent sort');
    answers.push({ ok: true, text: '```threadglyph\n{"edits":[{"old":"Hardware","new":"Hardware"}]}\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    expect([...panelEl().querySelectorAll('.tg-message')].at(-1)!.textContent).toContain('The agent found nothing to change.');

    await command('open-agent-chat').callback!();
    await flush();
    expect(chatEl().querySelector('.tg-legacy')?.textContent).toBe(AGENT_LEGACY_NOTE);
    const input = chatEl().querySelector<HTMLTextAreaElement>('.tg-chat-input')!;
    view.editor.selection = [note().indexOf('milk'), note().indexOf('milk')];
    answers.push({ ok: true, text: 'Fine as is.\n```threadglyph\n{"edits":[{"old":"milk","new":"milk"}]}\n```' });
    input.value = 'sort';
    buttonIn(chatEl(), 'Send')!.click();
    await flush();
    expect(chatEl().textContent).toContain('Fine as is. (The agent found nothing to change.)');
    expect(chatEl().querySelector('.tg-proposal')).toBeNull();
  });

  it('never saves an edit block to the thread, even an unreadable one (Gitar PR #10)', async () => {
    await commentOn('Groceries', '@Agent sort');
    answers.push({ ok: true, text: '```threadglyph\n{"edits":[{"old":"  - [ ] milk\n  - [ ] apples","new":\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    await commentOn('Hardware', '@Agent sort');
    answers.push({ ok: true, text: '```threadglyph\n{"edits":[]}\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    const saved = threadFiles().join();
    expect(saved).not.toContain('threadglyph\\n');
    expect(saved).not.toContain('apples');
    expect(saved).toContain('could not be read');
    expect(saved).toContain('did not propose any change');
  });

  it('shows an unreadable answer instead of dropping it, and compares side by side', async () => {
    await commentOn('Groceries', '@Agent sort');
    answers.push({ ok: true, text: 'Sorting.\n```threadglyph\n{"edits": [broken\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    expect(panelEl().querySelector('.tg-proposal .tg-ai-error')?.textContent).toContain('could not be read');

    await commentOn('Hardware', '@Agent sort');
    answers.push({ ok: true, text: '```threadglyph\n{"edits":[{"old":"Hardware","new":"Hardware store"}]}\n```' });
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    const ready = [...panelEl().querySelectorAll<HTMLElement>('.tg-proposal')].find((p) => !p.querySelector('.tg-ai-error'))!;
    buttonIn(ready, 'Compare')!.click();
    expect(openModals.at(-1)!.titleEl.textContent).toBe('Original vs. proposed');
    openModals.at(-1)!.close();
    buttonIn(view.editor.cm!.dom.querySelector<HTMLElement>('.tg-inline-proposal')!, 'Compare')!.click();
    expect(openModals.at(-1)!.titleEl.textContent).toBe('Original vs. proposed');
  });

  it('deletes the agent\'s reply with Cmd+Shift+Delete on its card', async () => {
    await commentOn('Groceries', '@Agent sort');
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    const panel = app.workspace.getLeavesOfType('threadglyph-panel')[0].view as unknown as { scope: { press(m: string[], k: string): unknown } };
    panelEl().querySelector<HTMLElement>('.tg-card[data-thread-id]')!.focus();
    expect(panel.scope.press(['Mod', 'Shift'], 'Delete')).toBe(false);
    buttonIn(openModals.at(-1)!.contentEl, 'Delete')!.click();
    await flush();
    const saved = JSON.parse(threadFiles()[0]);
    expect(saved.messages.map((m: { deletedAt?: string }) => !!m.deletedAt)).toEqual([false, true]);
  });

  it('saves a plain answer as a reply with no proposal', async () => {
    await commentOn('Groceries', '@agent anything to change?');
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    expect(panelEl().querySelector('.tg-proposal')).toBeNull();
    expect([...panelEl().querySelectorAll('.tg-message')].at(-1)!.textContent).toContain('No change needed.');
  });

  it('offers @Agent first in the mention menu', async () => {
    await commentOn('Groceries', 'First');
    const input = panelEl().querySelector<HTMLTextAreaElement>('textarea[data-draft-key^="reply:"]')!;
    input.value = '@';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event('input'));
    expect([...panelEl().querySelectorAll('.tg-mention-option')].map((o) => o.firstChild?.textContent)).toEqual(['@Agent', '@Local']);
    expect(panelEl().querySelector('.tg-mention-detail')?.textContent).toBe('proposes edits · via Local');
  });

  it('asks before reading other notes, and sends only what was allowed', async () => {
    await commentOn('Groceries', '@Agent add what pasta needs');
    answers.push(
      { ok: true, text: 'I need your recipes.\n```threadglyph\n{"read":{"search":"pasta","notes":["Recipes"]}}\n```' },
      { ok: true, text: SORT_ANSWER },
    );
    buttonIn(panelEl(), 'Send')!.click();
    await flush();
    const modal = openModals.at(-1)!;
    expect(modal.contentEl.textContent).toContain('Recipes.md');
    expect(requests).toHaveLength(1);
    buttonIn(modal.contentEl, 'Allow')!.click();
    await flush();
    expect(requests).toHaveLength(2);
    // Named notes, then search matches; a search never picks up daily notes or the note itself.
    expect(requests[1].vaultNotes?.map((n) => n.path)).toEqual(['Recipes.md', 'Italian.md']);
    expect(panelEl().querySelector('.tg-proposal')).not.toBeNull();
  });
});

describe('agent chat', () => {
  async function openChat() {
    await command('open-agent-chat').callback!();
    await flush();
    expect(chatEl().querySelector('.tg-header-title')?.textContent).toBe('Agent · Shopping');
  }
  async function say(text: string) {
    const input = chatEl().querySelector<HTMLTextAreaElement>('.tg-chat-input')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    // Enter is a new line; Cmd+Enter sends.
    const turns = () => chatEl().querySelectorAll('.tg-chat-you').length;
    const before = turns();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(turns()).toBe(before);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await flush();
  }

  it('proposes a change to the section at the cursor and applies it on Accept', async () => {
    await openChat();
    view.editor.selection = [note().indexOf('milk'), note().indexOf('milk')];
    answers.push({ ok: true, text: SORT_ANSWER });
    await say('sort the groceries');
    expect(requests[0].target?.label).toBe('The section “Shopping”');
    expect(requests[0].messages.at(-1)).toMatchObject({ origin: 'human', body: 'sort the groceries' });
    expect(note()).toBe(NOTE_TEXT);
    expect(chatEl().textContent).toContain('May change: the section “shopping” in “Shopping”');
    buttonIn(chatEl(), 'Accept')!.click();
    await flush();
    expect(note()).toBe(SORTED);
    expect(chatEl().textContent).toContain('Sorted the groceries alphabetically. — Applied.');
  });

  it('limits a request to the selection, keeps earlier turns, and can reject or clear', async () => {
    await openChat();
    await say('hello');
    const from = note().indexOf('Something');
    view.editor.selection = [from, from + 9];
    answers.push({ ok: true, text: '```threadglyph\n{"edits":[{"old":"Something else.","new":"Something better."}]}\n```' });
    await say('improve this');
    expect(requests[1].target).toEqual({ label: 'The lines of the passage', text: 'Something else.' });
    expect(requests[1].messages.map((m) => m.body)).toEqual(['hello', 'No change needed.', 'improve this']);
    buttonIn(chatEl(), 'Reject')!.click();
    await flush();
    expect(chatEl().textContent).toContain('Proposed a change. — Rejected.');
    expect(note()).toBe(NOTE_TEXT);
    buttonIn(chatEl(), 'Clear chat')!.click();
    await flush();
    expect(chatEl().querySelector('.tg-chat-you')).toBeNull();
  });

  it('refuses a target that is too long, and reports a failing assistant', async () => {
    await openChat();
    app.vault.adapter.files.set(NOTE, `# Big\n${'x'.repeat(40_001)}\n`);
    view.editor.selection = [8, 8];
    await say('shorten');
    expect(requests).toHaveLength(0);
    expect(chatEl().textContent).toContain('is too long for the agent');

    vi.spyOn(plugin.adapterFactory(plugin.settings)[0], 'ask').mockRejectedValue(new Error('socket closed'));
    view.editor.selection = [0, 3];
    await say('try');
    expect(chatEl().textContent).toContain('Local could not answer: socket closed');
  });

  it('sends with Cmd+Enter through its own shortcut scope', async () => {
    await openChat();
    const chat = app.workspace.getLeavesOfType('threadglyph-agent')[0].view as unknown as { scope: { press(m: string[], k: string): unknown } };
    (document.activeElement as HTMLElement | null)?.blur();
    expect(chat.scope.press(['Mod'], 'Enter')).toBe(true);
    const input = chatEl().querySelector<HTMLTextAreaElement>('.tg-chat-input')!;
    input.value = 'tidy';
    input.focus();
    expect(chat.scope.press(['Mod'], 'Enter')).toBe(false);
    await flush();
    expect(requests.at(-1)?.messages.at(-1)?.body).toBe('tidy');
  });

  it('names itself and its icon, and empties on close', async () => {
    await openChat();
    const chat = app.workspace.getLeavesOfType('threadglyph-agent')[0].view as unknown as { getDisplayText(): string; getIcon(): string; onClose(): Promise<void> };
    expect(chat.getDisplayText()).toBe('Threadglyph agent');
    expect(chat.getIcon()).toBe('bot');
    await chat.onClose();
    expect(chatEl().children).toHaveLength(0);
  });

  it('asks before sending to a cloud assistant', async () => {
    egress = 'cloud';
    await openChat();
    await say('sort');
    expect(openModals.at(-1)!.titleEl.textContent).toBe('Send to a cloud assistant?');
    buttonIn(openModals.at(-1)!.contentEl, 'Cancel')!.click();
    await flush();
    expect(requests).toHaveLength(0);
    expect(chatEl().textContent).toContain('Not sent.');
  });

  it('can cancel a running request, and explains when AI is off', async () => {
    await openChat();
    // The model never answers; only Cancel ends the request.
    const ask = plugin.adapterFactory(plugin.settings)[0];
    vi.spyOn(ask, 'ask').mockImplementation((_req, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, kind: 'cancelled', message: 'Cancelled.' }));
    }));
    const input = chatEl().querySelector<HTMLTextAreaElement>('.tg-chat-input')!;
    input.value = 'slow';
    buttonIn(chatEl(), 'Send')!.click();
    await flush();
    expect(chatEl().textContent).toContain('Asking the agent…');
    buttonIn(chatEl(), 'Cancel')!.click();
    await flush();
    expect(chatEl().textContent).toContain('Cancelled.');

    plugin.settings.aiEnabled = false;
    await plugin.saveSettings();
    await say('anything');
    expect(chatEl().textContent).toContain('Turn on AI in Threadglyph settings first.');
  });
});

describe('@agent inline in the note', () => {
  const INLINE = NOTE_TEXT.replace('- [ ] Groceries', '- [ ] Groceries @agent sort these');

  beforeEach(async () => {
    app.vault.adapter.files.set(NOTE, INLINE);
    syncEditor();
    await plugin.refresh();
  });
  const cursorOn = (text: string) => {
    const at = note().indexOf(text);
    view.editor.selection = [at, at];
  };

  it('runs the request on the cursor line and shows the change under it', async () => {
    const run = command('run-agent-on-line');
    cursorOn('sort these');
    expect(run.editorCheckCallback!(true, view.editor, view)).toBe(true);
    answers.push({ ok: true, text: SORT_ANSWER });
    run.editorCheckCallback!(false, view.editor, view);
    await flush();
    expect(requests[0].target?.text).toBe('- [ ] Groceries\n  - [ ] milk\n  - [ ] apples');
    expect(requests[0].messages.at(-1)?.body).toBe('sort these');
    expect(note()).toBe(INLINE);

    const widget = view.editor.cm!.dom.querySelector<HTMLElement>('.tg-inline-proposal')!;
    expect([...widget.querySelectorAll('.tg-inline-add')].map((e) => e.textContent)).toContain('+ - [ ] Groceries');
    expect([...widget.querySelectorAll('.tg-inline-remove')].map((e) => e.textContent)).toContain('− - [ ] Groceries @agent sort these');
    buttonIn(widget, 'Accept')!.click();
    await flush();
    // The change is applied and the request text removed, in one edit.
    expect(note()).toBe(SORTED);
    expect(view.editor.transactions).toHaveLength(1);
  });

  it('leaves the note, request included, exactly as it was on Reject', async () => {
    cursorOn('sort these');
    answers.push({ ok: true, text: SORT_ANSWER });
    command('run-agent-on-line').editorCheckCallback!(false, view.editor, view);
    await flush();
    buttonIn(view.editor.cm!.dom.querySelector<HTMLElement>('.tg-inline-proposal')!, 'Reject')!.click();
    await flush();
    expect(note()).toBe(INLINE);
    expect(view.editor.cm!.dom.querySelector('.tg-inline-proposal')).toBeNull();
  });

  it('drops an inline proposal whose text was edited, and reports plain answers', async () => {
    cursorOn('sort these');
    answers.push({ ok: true, text: SORT_ANSWER });
    command('run-agent-on-line').editorCheckCallback!(false, view.editor, view);
    await flush();
    app.vault.adapter.files.set(NOTE, INLINE.replace('apples', 'pears'));
    await plugin.refresh();
    expect(plugin.agents.forNote(NOTE)).toHaveLength(0);

    app.vault.adapter.files.set(NOTE, INLINE);
    cursorOn('sort these');
    command('run-agent-on-line').editorCheckCallback!(false, view.editor, view);
    await flush();
    expect(notices.at(-1)).toBe('No change needed.');
  });

  it('opens the ask window on a bare @agent line', async () => {
    app.vault.adapter.files.set(NOTE, `${NOTE_TEXT}@agent\n`);
    cursorOn('@agent');
    command('run-agent-on-line').editorCheckCallback!(false, view.editor, view);
    await flush();
    expect(requests).toHaveLength(0);
    expect(openModals.at(-1)).toBeInstanceOf(AgentAskModal);
  });

  it('goes ahead of other plugins\' @ menus, answering only from "@a"', () => {
    const registry = app.workspace.editorSuggest.suggests;
    expect(registry[0]).toBe(suggest());
    app.vault.adapter.files.set(NOTE, 'Ping @');
    expect(suggest().onTrigger(view.editor.offsetToPos(6) as never, view.editor as never)).toBeNull();
    app.vault.adapter.files.set(NOTE, 'Ping @m');
    expect(suggest().onTrigger(view.editor.offsetToPos(7) as never, view.editor as never)).toBeNull();
  });

  it('offers @agent from "@a", and opens the ask window in place of the typed text', () => {
    app.vault.adapter.files.set(NOTE, 'Plan @ag');
    const s = suggest();
    const cursor = view.editor.offsetToPos(8);
    const trigger = s.onTrigger(cursor as never, view.editor as never)!;
    expect(trigger.query).toBe('ag');
    expect(s.getSuggestions()[0].label).toBe('@agent');
    const el = document.createElement('div');
    s.renderSuggestion(s.getSuggestions()[0], el);
    expect(el.textContent).toContain('Opens a window');
    expect(el.textContent).toContain('Legacy');
    (s as unknown as { context: unknown }).context = { editor: view.editor, start: trigger.start, end: trigger.end, query: 'ag' };
    s.selectSuggestion();
    // The typed "@ag" is gone, so the note is as it was; the window asks what to do.
    expect(note()).toBe('Plan ');
    expect(openModals.at(-1)).toBeInstanceOf(AgentAskModal);
    expect(s.onTrigger(view.editor.offsetToPos(3) as never, view.editor as never)).toBeNull();
    (s as unknown as { context: unknown }).context = null;
    s.selectSuggestion();
  });

  it('is unavailable while AI is off', async () => {
    plugin.settings.aiEnabled = false;
    await plugin.saveSettings();
    cursorOn('sort these');
    expect(command('run-agent-on-line').editorCheckCallback!(true, view.editor, view)).toBe(false);
    expect(suggest().onTrigger(view.editor.offsetToPos(3) as never, view.editor as never)).toBeNull();
    expect(mentionsAgent('hi @Agent')).toBe(true);
    expect(mentionsAgent('me@agent.com')).toBe(false);
  });
});

describe('the @agent ask window', () => {
  const current = () => openModals.at(-1) as unknown as AgentAskModal;
  const modalEl = () => current().contentEl as unknown as HTMLElement;
  const press = () => (openModals.at(-1) as unknown as { scope: { press(m: string[], k: string): unknown } }).scope.press(['Mod'], 'Enter');
  function open(at = 'Groceries') {
    const offset = note().indexOf(at);
    view.editor.selection = [offset, offset];
    command('run-agent-on-line').editorCheckCallback!(false, view.editor, view);
    expect(openModals.at(-1)).toBeInstanceOf(AgentAskModal);
  }
  function type(text: string) {
    const input = modalEl().querySelector<HTMLTextAreaElement>('.tg-ask-input')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }

  it('asks what to do, shows the change as a diff or side by side, and applies it on Accept (⌘↩)', async () => {
    open();
    const scopes = [...modalEl().querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(scopes.map((r) => r.value)).toEqual(['anchor', 'section', 'note']);
    expect(scopes[0].checked).toBe(true);
    expect(modalEl().querySelector('.tg-legacy')?.textContent).toBe(AGENT_LEGACY_NOTE);
    expect(modalEl().textContent).toContain('The list item and everything under it (');
    expect(modalEl().textContent).toContain('Answered by Local (qwen3:8b)');
    // Nothing is sent without an instruction.
    buttonIn(modalEl(), 'Ask (⌘↩)')!.click();
    expect(requests).toHaveLength(0);

    type('sort these');
    answers.push({ ok: true, text: SORT_ANSWER });
    press();
    await flush();
    expect(requests[0].target?.text).toBe('- [ ] Groceries\n  - [ ] milk\n  - [ ] apples');
    expect(requests[0].messages.at(-1)?.body).toBe('sort these');
    expect(modalEl().textContent).toContain('Sorted the groceries alphabetically.');
    expect(modalEl().querySelector('.tg-diff-summary')?.textContent).toBe('1 line removed · 1 added');
    // The proposal also waits under the text in the note.
    expect(view.editor.cm!.dom.querySelector('.tg-inline-proposal')).not.toBeNull();
    buttonIn(modalEl(), 'Side by side')!.click();
    expect(modalEl().querySelectorAll('.tg-compare-removed, .tg-compare-added')).toHaveLength(2);
    buttonIn(modalEl(), 'Changes')!.click();
    expect(modalEl().querySelector('.tg-diff')).not.toBeNull();
    expect(note()).toBe(NOTE_TEXT);

    press();
    await flush();
    expect(note()).toBe(SORTED);
    expect(openModals).toHaveLength(0);
  });

  it('can be told to change the whole section instead', async () => {
    open();
    modalEl().querySelector<HTMLInputElement>('input[value=section]')!.dispatchEvent(new Event('change'));
    type('tidy');
    buttonIn(modalEl(), 'Ask (⌘↩)')!.click();
    await flush();
    expect(requests[0].target?.text).toBe('# Shopping\n- [ ] Groceries\n  - [ ] milk\n  - [ ] apples\n- [ ] Hardware');
    // A plain answer: Ask again keeps the request; Close closes.
    expect(modalEl().textContent).toContain('No change needed.');
    buttonIn(modalEl(), 'Ask again')!.click();
    expect(modalEl().querySelector<HTMLTextAreaElement>('.tg-ask-input')!.value).toBe('tidy');
    press();
    await flush();
    press();
    expect(openModals).toHaveLength(0);
  });

  it('starts on the section outside a list, and drops a rejected or unreadable change', async () => {
    open('Something else');
    expect(modalEl().querySelector<HTMLInputElement>('input[value=section]')!.checked).toBe(true);
    type('reword');
    answers.push({ ok: true, text: 'Ok.\n```threadglyph\n{"edits":[{"old":"nope","new":"x"}]}\n```' });
    press();
    await flush();
    expect(modalEl().querySelector('.tg-ai-error')?.textContent).toContain('is not there');
    buttonIn(modalEl(), 'Ask again')!.click();
    expect(plugin.agents.forNote(NOTE)).toHaveLength(0);
    answers.push({ ok: true, text: 'Ok.\n```threadglyph\n{"edits":[{"old":"Something else.","new":"Another thing."}]}\n```' });
    press();
    await flush();
    buttonIn(modalEl(), 'Reject')!.click();
    await flush();
    expect(openModals).toHaveLength(0);
    expect(plugin.agents.forNote(NOTE)).toHaveLength(0);
    expect(note()).toBe(NOTE_TEXT);
  });

  it('cancels a running request, and drops its late answer', async () => {
    open();
    type('sort these');
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    answers.push({ ok: true, text: SORT_ANSWER });
    press();
    await flush();
    expect(modalEl().textContent).toContain('Asking the agent…');
    buttonIn(modalEl(), 'Cancel')!.click();
    expect(modalEl().querySelector('.tg-ask-input')).not.toBeNull();
    release();
    await flush();
    expect(plugin.agents.forNote(NOTE)).toHaveLength(0);
    expect(modalEl().querySelector('.tg-ask-input')).not.toBeNull();
  });

  it('keeps an open proposal in the note when closed, and reports a note that changed before Accept', async () => {
    open();
    type('sort these');
    answers.push({ ok: true, text: SORT_ANSWER });
    press();
    await flush();
    app.vault.adapter.files.set(NOTE, NOTE_TEXT.replace('apples', 'pears'));
    press();
    await flush();
    expect(modalEl().querySelector('.tg-ai-error')?.textContent).toContain('changed since this preview');
    current().close();

    app.vault.adapter.files.set(NOTE, NOTE_TEXT);
    open();
    type('sort these');
    answers.push({ ok: true, text: SORT_ANSWER });
    press();
    await flush();
    current().close();
    await plugin.refresh();
    expect(view.editor.cm!.dom.querySelector('.tg-inline-proposal')).not.toBeNull();
  });

  it('closing while it runs cancels the request', async () => {
    open();
    type('sort these');
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    answers.push({ ok: true, text: SORT_ANSWER });
    press();
    await flush();
    current().close();
    release();
    await flush();
    expect(plugin.agents.forNote(NOTE)).toHaveLength(0);
  });

  it('says so when AI is off', () => {
    plugin.settings.aiEnabled = false;
    plugin.openAskAgent(view.editor as never, view.file as never, 0, 0);
    expect(notices.at(-1)).toContain('Turn on AI');
  });
});
