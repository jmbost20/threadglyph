// @vitest-environment happy-dom
import './obsidianStub';
import { WorkspaceLeaf } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadController } from '../src/controller';
import { ThreadStore } from '../src/storage/threadStore';
import { ThreadPanel, VIEW_TYPE_THREADGLYPH, type PanelActions, type PanelState } from '../src/ui/ThreadPanel';
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
    problems: store.loadProblems(),
    focusedThreadId: null,
    filter,
    ...overrides,
  };
}

const render = () => panel.update(state());
const q = <T extends HTMLElement = HTMLElement>(sel: string) => panel.contentEl.querySelector<T>(sel);
const qa = (sel: string) => [...panel.contentEl.querySelectorAll<HTMLElement>(sel)];
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
    setResolved: async (id, resolved) => {
      await ctl.setResolved(id, resolved);
      render();
    },
    reattach: vi.fn(async () => {}),
    goTo: vi.fn(async () => {}),
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

    q<HTMLButtonElement>('.tg-icon-button')!.click();
    const edit = () => q<HTMLTextAreaElement>(`textarea[data-draft-key="${draftKey.edit(thread.id, messageId)}"]`);
    expect(edit()?.value).toBe('Original');
    type(edit()!, 'Changed');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    button('Cancel')!.click();
    expect(edit()).toBeNull();
    expect(q('.tg-message-body')?.textContent).toBe('Original');

    q<HTMLButtonElement>('.tg-icon-button')!.click();
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
    q<HTMLButtonElement>('.tg-icon-button')!.click();
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
    const scroll = vi.fn();
    q<HTMLElement>('.tg-card')!.scrollIntoView = scroll;
    panel.scrollToThread(thread.id);
    expect(scroll).toHaveBeenCalled();
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
    expect(qa('.tg-card')[0].getAttribute('aria-label')).toBe('Thread 1');
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
    expect(qa('.tg-card')[2].getAttribute('aria-label')).toBe('Thread 2, resolved');
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
