// @vitest-environment happy-dom
import './obsidianStub';
import { WorkspaceLeaf, type Scope } from 'obsidian';
import { openModals } from './obsidianStub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadController } from '../src/controller';
import { ThreadStore } from '../src/storage/threadStore';
import { ThreadPanel, countLabel, VIEW_TYPE_THREADGLYPH, type AiCardView, type PanelActions, type PanelState } from '../src/ui/ThreadPanel';
import { buildThreadViews, draftKey, type ThreadFilter } from '../src/ui/viewModel';
import { MemoryFs, ai, fakeClock, human } from './helpers';
import { addReply } from '../src/model/thread';

const note = 'Notes/topic.md';
let doc = 'Intro. The passage under review. Outro.\n';
const range = (s: string) => [doc.indexOf(s), doc.indexOf(s) + s.length] as const;

let store: ThreadStore;
let ctl: ThreadController;
let panel: ThreadPanel;
let filter: ThreadFilter;
let actions: PanelActions;

function state(overrides: Partial<PanelState> = {}): PanelState {
  const pending = ctl.pending;
  return {
    status: 'ready',
    notePath: note,
    noteName: 'topic',
    views: buildThreadViews(store, note, doc),
    pendingQuote: pending?.notePath === note ? pending.anchor.quote : null,
    pendingImagePath: pending?.notePath === note ? (pending.anchor.imagePath ?? null) : null,
    problems: store.loadProblems(),
    focusedThreadId: null,
    filter,
    assistants: [],
    ai: {},
    ...overrides,
  };
}

const render = () => panel.update(state());
const q = <T extends HTMLElement = HTMLElement>(sel: string) => panel.contentEl.querySelector<T>(sel);
const qa = (sel: string) => [...panel.contentEl.querySelectorAll<HTMLElement>(sel)];
const scope = () => (panel as unknown as { scope: { press(m: string[], k: string): unknown } }).scope;
/** Opens every collapsed row of the Ask AI preview tree (they start closed so Enter sends the defaults). */
const expandAll = () => {
  for (let head = q<HTMLElement>('.tg-ai-group[aria-expanded="false"]'); head; head = q<HTMLElement>('.tg-ai-group[aria-expanded="false"]')) head.click();
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (label: string) => qa('button').find((b) => b.textContent === label);
const type = (el: HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input'));
};
const key = (el: HTMLElement, k: string, mod = false) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: mod, bubbles: true }));

beforeEach(async () => {
  doc = 'Intro. The passage under review. Outro.\n';
  filter = 'open';
  const clock = fakeClock();
  store = new ThreadStore(new MemoryFs(), clock);
  ctl = new ThreadController(store, () => human, clock);
  actions = {
    drafts: ctl.drafts,
    editing: ctl.editing,
    createThread: async (body) => (await ctl.commitThread(body)).ok,
    cancelNewThread: () => {
      ctl.cancelThread();
      render();
    },
    reply: async (id, body) => (await ctl.reply(id, body)).ok,
    startEdit: (id, m) => {
      ctl.startEdit(id, m);
      render();
    },
    saveEdit: async (id, m, body) => (await ctl.saveEdit(id, m, body)).ok,
    cancelEdit: (id, m) => {
      ctl.cancelEdit(id, m);
      render();
    },
    setMessageDeleted: async (id, m, deleted) => { const result = await ctl.setMessageDeleted(id, m, deleted); render(); return result.ok; },
    setThreadDeleted: async (id, deleted) => { const result = await ctl.setThreadDeleted(id, deleted); render(); return result.ok; },
    setResolved: async (id, resolved) => {
      await ctl.setResolved(id, resolved);
      render();
    },
    reattach: vi.fn(async () => {}),
    goTo: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    imageSrc: (path) => (path.includes('missing') ? null : `app://vault/${path}`),
    aiOpen: vi.fn(),
    aiScope: vi.fn(),
    aiAssistant: vi.fn(),
    aiSend: vi.fn(),
    proposalAccept: vi.fn(),
    proposalReject: vi.fn(),
    aiCancel: vi.fn(),
    aiClose: vi.fn(),
    aiAdopt: vi.fn(async () => true),
    setFilter: (f) => {
      filter = f;
      render();
    },
    rerender: render,
  };
  panel = new ThreadPanel(new WorkspaceLeaf() as never, actions);
  await panel.onOpen();
});

afterEach(async () => {
  await panel.onClose();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function createViaPanel(body: string) {
  ctl.beginThread(note, doc, ...range('The passage'));
  render();
  const input = q<HTMLTextAreaElement>('.tg-card-new textarea')!;
  type(input, body);
  button('Comment')!.click();
  await flush();
  return store.forNote(note)[0];
}

describe('ThreadPanel', () => {
  it('identifies itself and shows loading and no-note states', () => {
    expect(panel.getViewType()).toBe(VIEW_TYPE_THREADGLYPH);
    expect(panel.getDisplayText()).toBe('Threadglyph');
    expect(panel.getIcon()).toBeTruthy();
    expect(q('.tg-empty')?.textContent).toMatch(/Loading/);
    panel.update(state({ status: 'no-note', notePath: null, noteName: '' }));
    expect(q('.tg-empty')?.textContent).toMatch(/Open a note/);
    expect(q('.tg-header-title')?.textContent).toBe('Threadglyph');
  });

  it('shows an empty state for a note without threads', () => {
    render();
    expect(q('.tg-empty')?.textContent).toMatch(/No threads yet/);
    expect(q('.tg-header-meta')?.textContent).toBe('0 open');
  });

  it('creates a thread from the new-thread card', async () => {
    const thread = await createViaPanel('First comment');
    expect(thread.messages[0].body).toBe('First comment');
    expect(q('.tg-card-new')).toBeNull();
    expect(q('.tg-quote-link')?.textContent).toBe('The passage');
    expect(q('.tg-message-body')?.textContent).toBe('First comment');
    expect(ctl.drafts.size).toBe(0);
  });

  it('ignores an empty submit and asks before discarding a typed new comment', async () => {
    ctl.beginThread(note, doc, ...range('The passage'));
    render();
    button('Comment')!.click();
    await flush();
    expect(store.forNote(note)).toHaveLength(0);

    type(q<HTMLTextAreaElement>('.tg-card-new textarea')!, 'half-written');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    button('Cancel')!.click();
    expect(ctl.pending).not.toBeNull();
    key(q('.tg-card-new textarea')!, 'Escape');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(ctl.pending).toBeNull();
    expect(q('.tg-card-new')).toBeNull();
  });

  it('replies with Cmd+Enter and keeps a reply draft across re-renders', async () => {
    const thread = await createViaPanel('Question');
    const reply = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    type(reply, 'Draft reply');
    render();
    const again = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    expect(again.value).toBe('Draft reply');

    key(again, 'Enter', true);
    await flush();
    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['Question', 'Draft reply']);
  });

  it('restores focus and caret to the draft being typed after a re-render', async () => {
    const thread = await createViaPanel('Question');
    const reply = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    type(reply, 'abcdef');
    reply.focus();
    reply.setSelectionRange(2, 4);
    render();
    const again = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    expect(document.activeElement).toBe(again);
    expect([again.selectionStart, again.selectionEnd]).toEqual([2, 4]);
  });

  it('edits a message with Save, and Cancel leaves it unchanged', async () => {
    const thread = await createViaPanel('Original');
    const messageId = thread.messages[0].id;

    [...document.querySelectorAll<HTMLButtonElement>('.tg-message-action')].find((b) => b.textContent === 'Edit')!.click();
    const edit = () => q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.edit(thread.id, messageId)}"]`);
    expect(edit()?.value).toBe('Original');
    type(edit()!, 'Changed');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    button('Cancel')!.click();
    expect(edit()).toBeNull();
    expect(q('.tg-message-body')?.textContent).toBe('Original');

    [...document.querySelectorAll<HTMLButtonElement>('.tg-message-action')].find((b) => b.textContent === 'Edit')!.click();
    type(edit()!, 'Revised');
    button('Save')!.click();
    await flush();
    expect(edit()).toBeNull();
    expect(q('.tg-message-body')?.textContent).toBe('Revised');
    expect(q('.tg-edited')).not.toBeNull();
    expect(store.get(thread.id)!.messages[0].revisions[0].body).toBe('Original');
  });

  it('cancelling an unchanged edit does not prompt', async () => {
    await createViaPanel('Original');
    const confirm = vi.spyOn(window, 'confirm');
    [...document.querySelectorAll<HTMLButtonElement>('.tg-message-action')].find((b) => b.textContent === 'Edit')!.click();
    button('Cancel')!.click();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('renders comment text as plain text, never HTML', async () => {
    await createViaPanel('<img src=x onerror="window.__pwned=1"><b>bold</b>');
    expect(q('.tg-message-body img')).toBeNull();
    expect(q('.tg-message-body b')).toBeNull();
    expect(q('.tg-message-body')?.textContent).toContain('<img');
  });

  it('labels AI replies', async () => {
    const thread = await createViaPanel('Q');
    await store.save(addReply(thread, ai, 'Model answer'), thread.revision);
    render();
    expect(q('.tg-origin')?.textContent).toBe('AI');
  });

  it('resolves, hides behind the Open filter, and reopens', async () => {
    const thread = await createViaPanel('Done soon');
    button('Resolve')!.click();
    await flush();
    expect(store.get(thread.id)!.status).toBe('resolved');
    expect(q('.tg-card')).toBeNull();
    expect(q('.tg-empty')?.textContent).toMatch(/No open threads/);
    expect(button('Open')!.getAttribute('aria-pressed')).toBe('true');
    button('Resolved')!.click();
    expect(button('Resolved')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('.tg-card-resolved')).not.toBeNull();
    expect(q('.tg-card-resolved textarea')).toBeNull();
    button('Reopen')!.click();
    await flush();
    expect(store.get(thread.id)!.status).toBe('open');
  });

  it('navigates to the passage and shows reattach for a missing anchor', async () => {
    const thread = await createViaPanel('Anchored');
    q<HTMLButtonElement>('.tg-quote-link')!.click();
    expect(actions.goTo).toHaveBeenCalledWith(thread.id);

    doc = 'The text was rewritten entirely.';
    render();
    expect(q('.tg-quote-link')).toBeNull();
    expect(q('.tg-quote-stale')?.textContent).toBe('The passage');
    expect(q('.tg-anchor-problem')?.textContent).toMatch(/no longer/);
    button('Reattach to selection')!.click();
    expect(actions.reattach).toHaveBeenCalledWith(thread.id);
  });

  it('highlights the focused thread and scrolls to it', async () => {
    const thread = await createViaPanel('Focus me');
    panel.update(state({ focusedThreadId: thread.id }));
    expect(q('.tg-card-focused')).not.toBeNull();
    Object.defineProperty(panel.contentEl, 'clientHeight', { value: 600, configurable: true });
    panel.contentEl.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    q<HTMLElement>('.tg-card')!.getBoundingClientRect = () => ({ top: 900, height: 200 } as DOMRect);
    panel.contentEl.scrollTop = 0;
    panel.scrollToThread(thread.id);
    expect(panel.contentEl.scrollTop).toBe(600);
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
  });

  it('can bring a thread into view without moving focus', async () => {
    const thread = await createViaPanel('Stay put');
    q<HTMLElement>('.tg-card')!.scrollIntoView = vi.fn();
    (document.activeElement as HTMLElement | null)?.blur();
    panel.scrollToThread(thread.id, false);
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
  });

  it('focuses the new-thread composer', () => {
    ctl.beginThread(note, doc, ...range('The passage'));
    render();
    panel.focusNewThread();
    expect(document.activeElement).toBe(q('.tg-card-new textarea'));
  });

  it('lists unreadable files without hiding the rest', () => {
    panel.update(state({ problems: [{ path: 'threadglyph/threads/bad.json', error: 'not valid JSON' }] }));
    expect(q('.tg-problem')?.textContent).toMatch(/bad\.json \(not valid JSON\)/);
  });
});

describe('ThreadPanel double submit (Gitar review on PR #1)', () => {
  it('posts one reply when Reply is clicked twice and Cmd+Enter is pressed during the save', async () => {
    const thread = await createViaPanel('Question');
    const input = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    type(input, 'Only once');
    const reply = button('Reply')!;
    reply.click();
    expect(reply.hasAttribute('disabled')).toBe(true);
    reply.click();
    key(input, 'Enter', true);
    await flush();
    await flush();
    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['Question', 'Only once']);
  });

  it('creates one thread when Comment is double-clicked', async () => {
    ctl.beginThread(note, doc, ...range('The passage'));
    render();
    type(q<HTMLTextAreaElement>('.tg-card-new textarea')!, 'One thread');
    const comment = button('Comment')!;
    comment.click();
    comment.click();
    await flush();
    await flush();
    expect(store.forNote(note)).toHaveLength(1);
  });

  it('re-enables the same button after a failed submit so the user can retry', async () => {
    const thread = await createViaPanel('Question');
    // Keep the DOM in place so the original button's state is what gets checked.
    actions.rerender = () => {};
    const failing = vi.spyOn(actions, 'reply').mockResolvedValueOnce(false);
    const input = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    type(input, 'Keep me');
    const reply = button('Reply')! as HTMLButtonElement;
    reply.click();
    expect(reply.disabled).toBe(true);
    await flush();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(reply.disabled).toBe(false);
    expect(ctl.drafts.get(draftKey.reply(thread.id))).toBe('Keep me');

    reply.click();
    await flush();
    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['Question', 'Keep me']);
  });

  it('re-enables the button when submit throws', async () => {
    const thread = await createViaPanel('Question');
    actions.rerender = () => {};
    vi.spyOn(actions, 'reply').mockRejectedValueOnce(new Error('disk full'));
    const onError = vi.fn();
    process.on('unhandledRejection', onError);
    type(q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!, 'Keep me');
    const reply = button('Reply')! as HTMLButtonElement;
    reply.click();
    await flush();
    await flush();
    process.off('unhandledRejection', onError);
    expect(reply.disabled).toBe(false);
    expect(ctl.drafts.get(draftKey.reply(thread.id))).toBe('Keep me');
  });
});

describe('ThreadPanel review tools', () => {
  async function threeThreads() {
    doc = 'Alpha point. Beta point. Gamma point.\n';
    for (const [text, body] of [
      ['Gamma point', 'third'],
      ['Alpha point', 'first about apples'],
      ['Beta point', 'second'],
    ] as const) {
      ctl.beginThread(note, doc, ...range(text));
      await ctl.commitThread(body);
    }
    render();
  }
  const numbers = () => qa('.tg-card-number').map((b) => b.textContent);
  const search = () => q<HTMLInputElement>('.tg-search')!;

  it('numbers cards in reading order, matching the badges in the note', async () => {
    await threeThreads();
    expect(numbers()).toEqual(['1', '2', '3']);
    expect(qa('.tg-quote-link').map((b) => b.textContent)).toEqual(['Alpha point', 'Beta point', 'Gamma point']);
    expect(document.getElementById(qa('.tg-card')[0].getAttribute('aria-labelledby')!)?.textContent).toBe('Thread 1');
  });

  it('keeps numbers stable when a thread is resolved', async () => {
    await threeThreads();
    const beta = store.forNote(note).find((t) => t.messages[0].body === 'second')!;
    await ctl.setResolved(beta.id, true);
    render();
    expect(numbers()).toEqual(['1', '3']);
    filter = 'all';
    render();
    expect(numbers()).toEqual(['1', '3', '2']);
    expect(document.getElementById(qa('.tg-card')[2].getAttribute('aria-labelledby')!)?.textContent).toBe('Thread 2, resolved');
  });

  it('searches quotes, messages and authors, keeping focus in the search box', async () => {
    await threeThreads();
    const box = search();
    box.focus();
    box.value = 'APPLES';
    box.dispatchEvent(new Event('input'));
    expect(numbers()).toEqual(['1']);
    expect(document.activeElement).toBe(search());

    search().value = 'gamma';
    search().dispatchEvent(new Event('input'));
    expect(numbers()).toEqual(['3']);

    search().value = human.name;
    search().dispatchEvent(new Event('input'));
    expect(numbers()).toEqual(['1', '2', '3']);

    search().value = 'nothing like this';
    search().dispatchEvent(new Event('input'));
    expect(q('.tg-empty')?.textContent).toBe('No threads match “nothing like this”.');

    key(search(), 'Escape');
    expect(search().value).toBe('');
    expect(numbers()).toEqual(['1', '2', '3']);
  });

  it('clears a search that hides the thread being opened', async () => {
    await threeThreads();
    search().value = 'apples';
    search().dispatchEvent(new Event('input'));
    const gamma = store.forNote(note).find((t) => t.messages[0].body === 'third')!;
    panel.scrollToThread(gamma.id, false);
    expect(search().value).toBe('');
    expect(q(`[data-thread-id="${gamma.id}"]`)).not.toBeNull();
  });

  it('explains an empty Resolved filter', async () => {
    await threeThreads();
    button('Resolved')!.click();
    expect(q('.tg-empty')?.textContent).toBe('No resolved threads.');
    button('All')!.click();
    expect(numbers()).toEqual(['1', '2', '3']);
  });

  it('moves between cards with the arrow keys and opens the passage with Enter', async () => {
    await threeThreads();
    const cards = qa('.tg-card');
    cards[0].focus();
    key(cards[0], 'ArrowDown');
    expect(document.activeElement).toBe(cards[1]);
    key(cards[1], 'ArrowUp');
    expect(document.activeElement).toBe(cards[0]);
    key(cards[0], 'ArrowUp');
    expect(document.activeElement).toBe(cards[0]);
    key(cards[0], 'Enter');
    expect(actions.goTo).toHaveBeenCalledWith(cards[0].dataset.threadId);
  });

  it('leaves arrow keys alone while typing in a reply', async () => {
    await threeThreads();
    const reply = q<HTMLTextAreaElement>('.tg-card textarea')!;
    reply.focus();
    key(reply, 'ArrowDown');
    key(reply, 'Enter');
    expect(document.activeElement).toBe(reply);
    expect(actions.goTo).not.toHaveBeenCalled();
  });
});

describe('ThreadPanel image threads', () => {
  const imageDoc = 'Look: ![[Photos/view.png]] and ![[gone/missing.png]].\n';
  const at = (s: string) => [imageDoc.indexOf(s), imageDoc.indexOf(s) + s.length] as const;

  it('previews the pending image and the thread image, which jumps to the embed', async () => {
    doc = imageDoc;
    ctl.beginImageThread(note, doc, ...at('![[Photos/view.png]]'), 'Photos/view.png');
    render();
    const pendingImg = q<HTMLImageElement>('.tg-card-new .tg-image img')!;
    expect(pendingImg.getAttribute('src')).toBe('app://vault/Photos/view.png');
    expect(pendingImg.alt).toBe('Image: view.png');
    expect(q('.tg-card-new .tg-quote')).toBeNull();

    type(q<HTMLTextAreaElement>('.tg-card-new textarea')!, 'Nice view');
    button('Comment')!.click();
    await flush();
    const figure = q<HTMLButtonElement>('.tg-card .tg-image')!;
    expect(figure.tagName).toBe('BUTTON');
    expect(figure.getAttribute('aria-label')).toBe('Show view.png in the note');
    expect(q('.tg-card .tg-image-name')?.textContent).toBe('view.png');
    figure.click();
    expect(actions.goTo).toHaveBeenCalledWith(store.forNote(note)[0].id);
  });

  it('names a missing or damaged image file instead of showing it', async () => {
    doc = imageDoc;
    ctl.beginImageThread(note, doc, ...at('![[gone/missing.png]]'), 'gone/missing.png');
    await ctl.commitThread('Where did it go?');
    ctl.beginImageThread(note, doc, ...at('![[Photos/view.png]]'), 'Photos/view.png');
    await ctl.commitThread('Broken?');
    render();
    expect(q('.tg-image-missing')?.textContent).toBe('Image file not found: gone/missing.png');

    const img = q<HTMLImageElement>('.tg-image img')!;
    img.dispatchEvent(new Event('error'));
    expect(q('.tg-image img')).toBeNull();
    expect(qa('.tg-image-missing').map((e) => e.textContent)).toContain('view.png could not be displayed. The file may be damaged.');
  });

  it('shows an unanchored image without a jump link and with image wording', async () => {
    doc = imageDoc;
    ctl.beginImageThread(note, doc, ...at('![[Photos/view.png]]'), 'Photos/view.png');
    await ctl.commitThread('Lost soon');
    doc = 'The image was removed.';
    render();
    expect(q('.tg-image')?.tagName).toBe('DIV');
    expect(q('.tg-anchor-problem')?.textContent).toMatch(/no longer embedded/);
  });
});

const CLAUDE = [{ id: 'claude', name: 'Claude', detail: 'default', destination: 'Sent to Anthropic' }];
const THREE = [
  { id: 'local', name: 'Local', detail: 'qwen3:8b', destination: 'Stays on this computer' },
  { id: 'gemini', name: 'Gemini', detail: 'gemini-3.5-flash', destination: 'Sent to Google' },
  ...CLAUDE,
];

describe('ThreadPanel AI', () => {
  const preview = (over: Partial<AiCardView> = {}): AiCardView => ({
    state: { phase: 'preview', scope: 'anchor', assistant: 'claude', attempts: 0 },
    items: ['The passage (11 characters)', '1 message in this thread'],
    scopes: [
      { scope: 'anchor', label: 'Just the passage and the thread' },
      { scope: 'section', label: 'Also the section (40 characters)' },
    ],
    exactText: 'Note: topic <b>not html</b>',
    canSend: true,
    ...over,
  });
  async function withAi(card: AiCardView | null, assistants: PanelState['assistants'] = CLAUDE) {
    const thread = await createViaPanel('Question');
    actions.rerender = () => panel.update(state({ assistants, ai: card ? { [thread.id]: card } : {} }));
    actions.rerender();
    return thread;
  }

  it('starts with its rows collapsed, sends once on Enter, and Escape cancels the whole request', async () => {
    const thread = await withAi(preview());
    expect(q('.tg-ai-exact')).toBeNull();
    expect(qa('.tg-ai-group').map((g) => g.textContent)).toEqual([
      '▸What to sendJust the passage and the thread',
      '▸Exact text27 characters',
    ]);
    const send = button('Send')!;
    key(send, 'Enter');
    key(send, 'Enter');
    expect(actions.aiSend).toHaveBeenCalledTimes(1);
    key(send, 'Escape');
    // The owner asked (2026-09-30) that Escape in the preview cancel everything, the asking comment included.
    expect(actions.aiClose).toHaveBeenCalledWith(thread.id, true);
    expect(actions.goTo).toHaveBeenCalledWith(thread.id);
    expect(store.get(thread.id)!.messages).toHaveLength(1);
  });

  it('offers Ask only when an assistant is enabled and no session is open', async () => {
    const thread = await withAi(null);
    button('Ask AI')!.click();
    expect(actions.aiOpen).toHaveBeenCalledWith(thread.id);
    panel.update(state({ assistants: [] }));
    expect(button('Ask AI')).toBeUndefined();
    panel.update(state({ assistants: CLAUDE, ai: { [thread.id]: preview() } }));
    expect(button('Ask AI')).toBeUndefined();
  });

  it('shows exactly what will be sent, with scope choice, before sending', async () => {
    const thread = await withAi(preview());
    expect(q('.tg-ai-title')?.textContent).toBe('Ask AI');
    expect(q('.tg-ai-note')?.textContent).toBe('Claude will receive the items below. Sent to Anthropic.');
    expect(q('.tg-ai-assistants')).toBeNull();
    expandAll();
    expect(qa('.tg-ai-items li').map((li) => li.textContent)).toEqual(['The passage (11 characters)', '1 message in this thread']);
    expect(q('.tg-ai-exact pre')?.textContent).toBe('Note: topic <b>not html</b>');
    expect(q('.tg-ai-exact b')).toBeNull();
    const radios = qa('.tg-ai-scope input') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    radios[1].dispatchEvent(new Event('change'));
    expect(actions.aiScope).toHaveBeenCalledWith(thread.id, 'section');
    button('Send')!.click();
    expect(actions.aiSend).toHaveBeenCalledWith(thread.id);
    button('Cancel')!.click();
    expect(actions.aiClose).toHaveBeenCalledWith(thread.id, true);
  });

  it('disables Send when no attempts remain', async () => {
    await withAi(preview({ canSend: false }));
    expect((button('Send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('can cancel a running request', async () => {
    const thread = await withAi(preview({ state: { phase: 'running', scope: 'anchor', assistant: 'claude', attempts: 1 } }));
    expect(q('.tg-ai-title')?.textContent).toBe('Asking Claude…');
    button('Cancel')!.click();
    expect(actions.aiCancel).toHaveBeenCalledWith(thread.id);
  });

  it('lets the user edit, add, retry or discard a draft', async () => {
    const draft = preview({ state: { phase: 'draft', scope: 'anchor', assistant: 'claude', attempts: 1, text: 'Model draft' } });
    const thread = await withAi(draft);
    expect(q('.tg-ai-title')?.textContent).toBe('Claude · reply could not be saved');
    const input = q<HTMLTextAreaElement>(`textarea[data-draft-key="ai:${thread.id}"]`)!;
    expect(input.value).toBe('Model draft');
    type(input, 'Model draft, tightened');
    button('Retry')!.click();
    expect(actions.aiSend).toHaveBeenCalledWith(thread.id);

    const add = button('Add to thread') as HTMLButtonElement;
    add.click();
    add.click();
    expect(add.disabled).toBe(true);
    await flush();
    expect(actions.aiAdopt).toHaveBeenCalledTimes(1);
    expect(actions.aiAdopt).toHaveBeenCalledWith(thread.id, 'Model draft, tightened');
    expect(ctl.drafts.has(`ai:${thread.id}`)).toBe(false);
  });

  it('keeps an edited draft when adding fails, and asks before discarding edits', async () => {
    const thread = await withAi(preview({ state: { phase: 'draft', scope: 'anchor', assistant: 'claude', attempts: 1, text: 'Model draft' } }));
    vi.mocked(actions.aiAdopt).mockResolvedValueOnce(false);
    const input = q<HTMLTextAreaElement>('.tg-ai textarea')!;
    type(input, 'Edited');
    button('Add to thread')!.click();
    await flush();
    expect(ctl.drafts.get(`ai:${thread.id}`)).toBe('Edited');
    button('Add to thread')!.click();
    type(q<HTMLTextAreaElement>('.tg-ai textarea')!, '   ');
    button('Add to thread')!.click();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    type(q<HTMLTextAreaElement>('.tg-ai textarea')!, 'Edited again');
    button('Discard')!.click();
    expect(actions.aiClose).not.toHaveBeenCalled();
    button('Discard')!.click();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(actions.aiClose).toHaveBeenCalledWith(thread.id);
  });

  it('discards an untouched draft without asking and hides Retry when attempts are used up', async () => {
    const thread = await withAi(preview({ state: { phase: 'draft', scope: 'anchor', assistant: 'claude', attempts: 3, text: 'Draft' }, canSend: false }));
    const confirm = vi.spyOn(window, 'confirm');
    expect(button('Retry')).toBeUndefined();
    button('Discard')!.click();
    expect(confirm).not.toHaveBeenCalled();
    expect(actions.aiClose).toHaveBeenCalledWith(thread.id);
  });

  it('explains errors and offers a bounded retry', async () => {
    const thread = await withAi(preview({ state: { phase: 'error', scope: 'anchor', assistant: 'claude', attempts: 1, kind: 'auth', message: 'Claude Code is not signed in.' } }));
    expect(q('.tg-ai-error')?.textContent).toBe('Claude Code is not signed in.');
    button('Retry')!.click();
    expect(actions.aiSend).toHaveBeenCalledWith(thread.id);
    button('Close')!.click();
    expect(actions.aiClose).toHaveBeenCalledWith(thread.id);

    panel.update(state({ assistants: CLAUDE, ai: { [thread.id]: preview({ state: { phase: 'error', scope: 'anchor', assistant: 'claude', attempts: 3, kind: 'quota', message: 'Limit' } , canSend: false }) } }));
    expect(button('Retry')).toBeUndefined();
    expect(q('.tg-ai-note')?.textContent).toMatch(/No retries left/);
  });
});

describe('ThreadPanel @ mentions', () => {
  async function replyBox() {
    const thread = await createViaPanel('Question');
    panel.update(state({ assistants: CLAUDE }));
    return { thread, input: q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)! };
  }
  const typeAtEnd = (input: HTMLTextAreaElement, value: string) => {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event('input'));
  };

  it('suggests the assistant after @ and inserts it with Enter', async () => {
    const { thread, input } = await replyBox();
    typeAtEnd(input, 'Thoughts @cl');
    expect(qa('.tg-mention-option').map((o) => o.firstChild?.textContent)).toEqual(['@Claude']);
    expect(q('.tg-mention-detail')?.textContent).toBe('default');
    expect(q('.tg-mention-option')?.getAttribute('aria-selected')).toBe('true');
    key(input, 'ArrowDown');
    key(input, 'ArrowUp');
    key(input, 'Enter');
    expect(input.value).toBe('Thoughts @Claude ');
    expect(q('.tg-mention-menu')).toBeNull();
    expect(ctl.drafts.get(draftKey.reply(thread.id))).toBe('Thoughts @Claude ');
    expect(store.get(thread.id)!.messages).toHaveLength(1);
  });

  it('picks with the mouse or Tab, and closes on Escape, blur or a non-match', async () => {
    const { input } = await replyBox();
    typeAtEnd(input, '@');
    q('.tg-mention-option')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(input.value).toBe('@Claude ');

    typeAtEnd(input, 'x @C');
    key(input, 'Tab');
    expect(input.value).toBe('x @Claude ');

    typeAtEnd(input, 'y @');
    key(input, 'Escape');
    expect(q('.tg-mention-menu')).toBeNull();
    expect(input.value).toBe('y @');

    typeAtEnd(input, 'z @');
    input.dispatchEvent(new Event('blur'));
    expect(q('.tg-mention-menu')).toBeNull();

    typeAtEnd(input, 'mail@example');
    expect(q('.tg-mention-menu')).toBeNull();
    typeAtEnd(input, '@zzz');
    expect(q('.tg-mention-menu')).toBeNull();
    key(input, 'ArrowDown');
  });

  it('leaves Cmd+Enter to submit while the menu is open', async () => {
    const { thread, input } = await replyBox();
    typeAtEnd(input, 'Send now @');
    key(input, 'Enter', true);
    await flush();
    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['Question', 'Send now @']);
  });

  it('shows no menu when AI is off', async () => {
    const thread = await createViaPanel('Question');
    const input = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    typeAtEnd(input, '@');
    expect(q('.tg-mention-menu')).toBeNull();
  });
});

describe('ThreadPanel with several assistants', () => {
  const card = (phase: 'preview' | 'error', assistant = 'local'): AiCardView => ({
    state:
      phase === 'preview'
        ? { phase, scope: 'anchor', assistant, attempts: 0 }
        : { phase, scope: 'anchor', assistant, attempts: 1, kind: 'network', message: 'Ollama is not reachable.' },
    items: ['The passage (11 characters)'],
    scopes: [{ scope: 'anchor', label: 'Just the passage and the thread' }],
    exactText: 'x',
    canSend: true,
  });

  it('walks the preview tree with the arrow keys; moving onto an option chooses it; Enter sends', async () => {
    const thread = await createViaPanel('Question');
    const twoScopes = { ...card('preview'), scopes: [{ scope: 'anchor' as const, label: 'Just the passage' }, { scope: 'section' as const, label: 'Also the section' }] };
    actions.rerender = () => panel.update(state({ assistants: THREE, ai: { [thread.id]: twoScopes } }));
    actions.rerender();
    const row = (id: string) => q<HTMLElement>(`.tg-ai-group[data-row="${id}"]`)!;
    row('scope').focus();
    key(row('scope'), 'ArrowDown');
    expect(document.activeElement).toBe(row('model'));
    key(row('model'), 'ArrowUp');
    expect(document.activeElement).toBe(row('scope'));
    key(row('scope'), 'ArrowRight');
    expect(row('scope').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(row('scope'));
    key(row('scope'), 'ArrowRight');
    const [anchor, section] = qa('.tg-ai-scope input') as HTMLInputElement[];
    expect(document.activeElement).toBe(anchor);
    key(anchor, 'ArrowDown');
    expect(document.activeElement).toBe(section);
    expect(actions.aiScope).toHaveBeenCalledWith(thread.id, 'section');
    key(section, 'ArrowLeft');
    expect(document.activeElement).toBe(row('scope'));
    key(row('scope'), 'ArrowLeft');
    expect(row('scope').getAttribute('aria-expanded')).toBe('false');
    key(row('scope'), 'Tab');
    key(row('scope'), 'Enter');
    expect(actions.aiSend).toHaveBeenCalledWith(thread.id);
    // Cmd+Enter in the preview sends too (through the panel's shortcut scope).
    row('scope').focus();
    expect(scope().press(['Mod'], 'Enter')).toBe(false);
  });

  it('lets the user pick the assistant, showing each model and where it sends', async () => {
    const thread = await createViaPanel('Question');
    panel.update(state({ assistants: THREE, ai: { [thread.id]: card('preview') } }));
    expandAll();
    const options = qa('.tg-ai-assistant');
    expect(options.map((o) => o.textContent)).toEqual([
      'Localqwen3:8b · Stays on this computer',
      'Geminigemini-3.5-flash · Sent to Google',
      'Claudedefault · Sent to Anthropic',
    ]);
    expect((qa('.tg-ai-assistant input') as HTMLInputElement[]).map((r) => r.checked)).toEqual([true, false, false]);
    expect(q('.tg-ai-note')?.textContent).toBe('Local will receive the items below. Stays on this computer.');
    (qa('.tg-ai-assistant input')[1] as HTMLInputElement).dispatchEvent(new Event('change'));
    expect(actions.aiAssistant).toHaveBeenCalledWith(thread.id, 'gemini');
  });

  it('offers the other assistants when one fails', async () => {
    const thread = await createViaPanel('Question');
    panel.update(state({ assistants: THREE, ai: { [thread.id]: card('error') } }));
    expect(q('.tg-ai-title')?.textContent).toBe('Local could not answer');
    expect(button('Ask Local')).toBeUndefined();
    button('Ask Gemini')!.click();
    expect(actions.aiAssistant).toHaveBeenCalledWith(thread.id, 'gemini');
    button('Ask Claude')!.click();
    expect(actions.aiAssistant).toHaveBeenCalledWith(thread.id, 'claude');
  });

  it('names an assistant that was switched off generically', async () => {
    const thread = await createViaPanel('Question');
    panel.update(state({ assistants: CLAUDE, ai: { [thread.id]: card('error', 'gone') } }));
    expect(q('.tg-ai-title')?.textContent).toBe('AI could not answer');
  });

  it('suggests every enabled assistant after @', async () => {
    const thread = await createViaPanel('Question');
    panel.update(state({ assistants: THREE }));
    const input = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    input.value = '@';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event('input'));
    expect(qa('.tg-mention-option').map((o) => o.firstChild?.textContent)).toEqual(['@Local', '@Gemini', '@Claude']);
    input.value = '@g';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input'));
    key(input, 'Enter');
    expect(input.value).toBe('@Gemini ');
  });
});

describe('ThreadPanel search shortcut', () => {
  it('Cmd/Ctrl+F in the panel focuses the search box and selects its text', async () => {
    await createViaPanel('Question');
    const search = q<HTMLInputElement>('.tg-search')!;
    search.value = 'old';
    const scope = (panel as unknown as { scope: { press(m: string[], k: string): unknown } }).scope;
    expect(scope.press(['Mod'], 'f')).toBe(false);
    expect(document.activeElement).toBe(search);
    expect([search.selectionStart, search.selectionEnd]).toEqual([0, 3]);
  });
});


describe('custom filter controls', () => {
  it('keeps the existing status row and filters by agent below it, with a reset', async () => {
    const thread = await createViaPanel('Question');
    await ctl.addAiReply(thread.id, 'Local', 'Answer', false);
    render();
    expect(qa('.tg-filter-option').map((b) => b.textContent)).toEqual(['Open', 'Resolved', 'All']);
    expect(q('.tg-filter')!.nextElementSibling?.classList.contains('tg-custom-filters')).toBe(true);
    const agent = q<HTMLSelectElement>('select[aria-label="Agent"]')!;
    expect([...agent.options].map((o) => o.textContent)).toEqual(['Any agent or person', 'Local']);
    agent.value = 'Local';
    agent.dispatchEvent(new Event('change'));
    expect(q<HTMLDetailsElement>('.tg-custom-filters')!.open).toBe(true);
    expect(qa('.tg-card[data-thread-id]')).toHaveLength(1);
    const date = q<HTMLInputElement>('input[aria-label="Comment from"]')!;
    date.value = '2099-01-01';
    date.dispatchEvent(new Event('change'));
    expect(qa('.tg-card[data-thread-id]')).toHaveLength(0);
    expect(q('.tg-empty')!.textContent).toContain('No threads match these filters');
    button('Clear custom filters')!.click();
    expect(qa('.tg-card[data-thread-id]')).toHaveLength(1);
  });
});

it('asks before deleting a clicked comment with Command Shift Backspace, and Undo restores it', async () => {
  const thread = await createViaPanel('Keep recoverable');
  const message = q<HTMLElement>('.tg-message')!;
  message.click();
  expect(document.activeElement).toBe(message);
  // The panel's own shortcut scope takes it, so Obsidian's editor shortcuts cannot swallow it.
  expect(scope().press(['Mod', 'Shift'], 'Backspace')).toBe(false);
  await flush();
  expect(openModals).toHaveLength(1);
  expect(store.get(thread.id)!.messages[0].deletedAt).toBeUndefined();
  const confirm = [...openModals[0].contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!;
  expect(document.activeElement).toBe(confirm);
  confirm.click();
  await flush();
  expect(openModals).toHaveLength(0);
  expect(q('.tg-card[data-thread-id]')).toBeNull();
  const saved = store.get(thread.id)!.messages[0];
  expect(saved.deletedAt).toBeTruthy();
  expect(saved.body).toBe('Keep recoverable');
  panel.update(state({ deletedMessages: [{ threadId: thread.id, message: saved }] }));
  button('Undo delete')!.click();
  await flush();
  expect(q('.tg-message-body')?.textContent).toBe('Keep recoverable');
});

it('deletes on Enter in the confirmation, even when focus moved to Cancel', async () => {
  const thread = await createViaPanel('Enter removes');
  button('Delete')!.click();
  const modal = openModals[0];
  [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.focus();
  expect((modal.scope as unknown as Scope & { press(m: string[], k: string): unknown }).press([], 'Enter')).toBe(false);
  await flush();
  expect(openModals).toHaveLength(0);
  expect(store.get(thread.id)!.messages[0].deletedAt).toBeTruthy();
});

it('keeps the comment when the delete confirmation is cancelled', async () => {
  const thread = await createViaPanel('Stay put');
  button('Delete')!.click();
  expect(openModals[0].titleEl.textContent).toBe('Delete this comment?');
  [...openModals[0].contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
  await flush();
  expect(openModals).toHaveLength(0);
  expect(store.get(thread.id)!.messages[0].deletedAt).toBeUndefined();
  expect(q('.tg-message-body')?.textContent).toBe('Stay put');
});

describe('Command Shift arrows in the panel', () => {
  async function threeCards() {
    doc = 'Alpha point. Beta point. Gamma point.\n';
    for (const [text, body] of [['Alpha point', 'one'], ['Beta point', 'two'], ['Gamma point', 'three']] as const) {
      ctl.beginThread(note, doc, ...range(text));
      await ctl.commitThread(body);
    }
    render();
    return qa('.tg-card[data-thread-id]').map((c) => c.dataset.threadId!);
  }
  const press = (k: string) => (panel.scope as unknown as Scope & { press(m: string[], k: string): unknown }).press(['Mod', 'Shift'], k);

  it('steps to the next and previous card, wrapping, and highlights each passage', async () => {
    const ids = await threeCards();
    expect(press('ArrowRight')).toBe(false);
    expect(actions.select).toHaveBeenLastCalledWith(ids[0]);
    expect(document.activeElement).toBe(q(`[data-thread-id="${ids[0]}"]`));
    press('ArrowRight');
    expect(actions.select).toHaveBeenLastCalledWith(ids[1]);
    press('ArrowLeft');
    press('ArrowLeft');
    expect(actions.select).toHaveBeenLastCalledWith(ids[2]);
    press('ArrowRight');
    expect(actions.select).toHaveBeenLastCalledWith(ids[0]);
  });

  it('starts from the focused thread, and keeps focus on its card across a re-render', async () => {
    const ids = await threeCards();
    (document.activeElement as HTMLElement | null)?.blur();
    panel.update(state({ focusedThreadId: ids[1] }));
    press('ArrowLeft');
    expect(actions.select).toHaveBeenLastCalledWith(ids[0]);
    panel.update(state({ focusedThreadId: ids[0] }));
    expect(document.activeElement).toBe(q(`[data-thread-id="${ids[0]}"]`));
  });

  it('leaves the keys to text selection while typing, and does nothing with no cards', async () => {
    await threeCards();
    q<HTMLTextAreaElement>('.tg-card textarea')!.focus();
    expect(press('ArrowRight')).toBe(true);
    expect(actions.select).not.toHaveBeenCalled();
    doc = 'Nothing here.\n';
    panel.update(state({ views: [] }));
    (document.activeElement as HTMLElement | null)?.blur();
    expect(press('ArrowRight')).toBe(true);
    expect(actions.select).not.toHaveBeenCalled();
  });
});

it('does not delete a comment when the deletion chord edits text in a reply', async () => {
  const thread = await createViaPanel('Do not delete');
  q('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, shiftKey: true, bubbles: true }));
  await flush();
  expect(store.get(thread.id)!.messages[0].deletedAt).toBeUndefined();
});

it('centers a new composer and preserves viewport position across ordinary updates', () => {
  ctl.beginThread(note, doc, ...range('The passage'));
  render();
  panel.focusNewThread();
  expect(document.activeElement).toBe(q('.tg-card-new textarea'));
  panel.contentEl.scrollTop = 450;
  render();
  expect(panel.contentEl.scrollTop).toBe(450);
});

it('keeps the Ask AI box centered when a new @mention thread also becomes the focused card', async () => {
  const thread = await createViaPanel('Question');
  panel.update(state());
  q<HTMLTextAreaElement>('textarea')!.focus();
  Object.defineProperty(panel.contentEl, 'clientHeight', { value: 600, configurable: true });
  panel.contentEl.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  const aiView: AiCardView = {
    state: { phase: 'preview', scope: 'section', assistant: 'local', attempts: 0 },
    items: [], scopes: [], exactText: '', canSend: true,
  };
  const proto = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('tg-ai')) return { top: 1300, height: 200 } as DOMRect;
    if (this.classList.contains('tg-card')) return { top: 800, height: 900 } as DOMRect;
    return proto.call(this);
  };
  try {
    panel.contentEl.scrollTop = 0;
    panel.update(state({ focusedThreadId: thread.id, ai: { [thread.id]: aiView } }));
    expect(document.activeElement?.textContent).toBe('▸What to send');
    // Centered on the AI box (1300 - (600 - 200) / 2), not re-scrolled to the card's top.
    expect(panel.contentEl.scrollTop).toBe(1100);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = proto;
  }
});

describe('ThreadPanel keyboard shortcuts', () => {
  it('Cmd+Enter posts from any comment box; Enter is a new line even with an @mention', async () => {
    const thread = await createViaPanel('Question');
    panel.update(state({ assistants: CLAUDE }));
    const input = q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!;
    type(input, 'Thoughts @Claude');
    input.focus();
    key(input, 'Enter');
    await flush();
    expect(store.get(thread.id)!.messages).toHaveLength(1);
    expect(scope().press(['Mod'], 'Enter')).toBe(false);
    await flush();
    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['Question', 'Thoughts @Claude']);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(scope().press(['Mod'], 'Enter')).toBe(true);
  });

  it('Cmd+D (or Cmd+Shift+Delete) asks to delete the latest comment from the card or its reply box, not while editing', async () => {
    const thread = await createViaPanel('First');
    await ctl.reply(thread.id, 'Latest');
    render();
    const card = q<HTMLElement>('.tg-card[data-thread-id]')!;
    card.focus();
    expect(scope().press(['Mod', 'Shift'], 'Delete')).toBe(false);
    expect(openModals.at(-1)!.contentEl.textContent).toContain('Latest');
    openModals.at(-1)!.close();
    // From the reply box too (owner feedback 2026-10-01).
    q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!.focus();
    expect(scope().press(['Mod'], 'd')).toBe(false);
    expect(openModals.at(-1)!.contentEl.textContent).toContain('Latest');
    openModals.at(-1)!.close();
    // A focused comment deletes that comment.
    q<HTMLElement>(`.tg-message[data-message-id="${thread.messages[0].id}"]`)!.focus();
    expect(scope().press(['Mod'], 'd')).toBe(false);
    expect(openModals.at(-1)!.contentEl.textContent).toContain('First');
    openModals.at(-1)!.close();
    q<HTMLInputElement>('.tg-search')!.focus();
    expect(scope().press(['Mod'], 'd')).toBe(true);
    (document.activeElement as HTMLElement).blur();
    expect(scope().press(['Mod', 'Shift'], 'Backspace')).toBe(true);
  });

  it('Cmd+Shift+D or Delete thread deletes the whole thread, restorable in one step', async () => {
    const thread = await createViaPanel('First');
    await ctl.reply(thread.id, 'Second');
    render();
    q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.reply(thread.id)}"]`)!.focus();
    expect(scope().press(['Mod', 'Shift'], 'd')).toBe(false);
    expect(openModals.at(-1)!.titleEl.textContent).toBe('Delete this whole thread (2 comments)?');
    [...openModals.at(-1)!.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click();
    await flush();
    expect(store.get(thread.id)!.messages.every((m) => m.deletedAt)).toBe(true);
    expect(q('.tg-card[data-thread-id]')).toBeNull();
    panel.update(state({ deletedThreads: [{ threadId: thread.id, preview: 'First', count: 2 }] }));
    expect(q('.tg-deleted')!.textContent).toContain('Thread: First (2 comments)');
    button('Restore thread')!.click();
    await flush();
    expect(store.get(thread.id)!.messages.some((m) => m.deletedAt)).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(scope().press(['Mod', 'Shift'], 'd')).toBe(true);
  });

  it('E edits a focused comment; the Edit and Delete links sit under it, out of the Tab order', async () => {
    const thread = await createViaPanel('Original');
    const message = q<HTMLElement>('.tg-message')!;
    const links = [...message.querySelectorAll<HTMLButtonElement>('.tg-message-action')];
    expect(links.map((b) => [b.textContent, b.getAttribute('tabindex')])).toEqual([['Edit', '-1'], ['Delete', '-1']]);
    expect(message.lastElementChild!.className).toBe('tg-message-actions');
    message.focus();
    message.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.edit(thread.id, thread.messages[0].id)}"]`)).not.toBeNull();
    links[1].click();
    expect(openModals.at(-1)!.titleEl.textContent).toBe('Delete this comment?');
  });
});

describe('thread list feedback (owner UAT 2026-10-01)', () => {
  it('shows counts on the Open / Resolved / All tabs, capped at 99+', async () => {
    const thread = await createViaPanel('One');
    await ctl.setResolved(thread.id, true);
    await createViaPanel('Two');
    render();
    expect(qa('.tg-filter-option').map((b) => [b.textContent, b.dataset.count])).toEqual([['Open', '1'], ['Resolved', '1'], ['All', '2']]);
    expect(countLabel(99)).toBe('99');
    expect(countLabel(100)).toBe('99+');
  });

  it('says how many threads lost their passage, and lists them first with Reattach', async () => {
    const thread = await createViaPanel('Lost');
    doc = 'Intro. Rewritten. Outro.\n';
    render();
    expect(q('.tg-header-warning')?.textContent).toBe('1 thread lost its passage and needs reattaching (shown first).');
    expect(q('.tg-card[data-thread-id]')?.dataset.threadId).toBe(thread.id);
    expect(button('Reattach to selection')).toBeDefined();
  });

  it('moves the keyboard into the new thread\'s reply box after posting it', async () => {
    // As in the plugin: a posted thread becomes the focused one before the panel re-renders.
    const rerender = actions.rerender;
    actions.rerender = () => panel.update(state({ focusedThreadId: store.forNote(note).at(-1)?.id ?? null }));
    const thread = await createViaPanel('Hello');
    actions.rerender = rerender;
    expect((document.activeElement as HTMLElement).dataset.draftKey).toBe(draftKey.reply(thread.id));
    // Later selections do not steal the keyboard.
    const other = (document.activeElement as HTMLElement);
    other.blur();
    panel.update(state({ focusedThreadId: null }));
    panel.update(state({ focusedThreadId: thread.id }));
    expect(document.activeElement).toBe(document.body);
    // The flag is used once, even when the post's first update has no thread to focus (Gitar on #10).
    await createViaPanel('Again');
    panel.update(state({ focusedThreadId: null }));
    panel.update(state({ focusedThreadId: thread.id }));
    expect(document.activeElement?.closest('textarea')).toBeNull();
  });
});

