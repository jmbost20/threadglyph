// @vitest-environment happy-dom
import { FakeApp, notices, openModals, type MarkdownView } from './obsidianStub';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ThreadglyphPlugin from '../src/main';
import type { AiAdapter, AiRequest, AiResult } from '../src/ai/types';
import { JOBS_DIR } from '../src/knowledge/coordinator';
import type { KnowledgeVault } from '../src/knowledge/coordinator';
import { field, renderObject } from '../src/knowledge/objects';
import { THREADS_DIR } from '../src/storage/paths';
import type { ThreadRecord } from '../src/model/types';

type Fake = InstanceType<typeof FakeApp>;

const NOTE = 'Reading/Week 3.md';
const NOTE_TEXT = '# Consistency\n\nReplicas converge eventually once writes stop.\n\n# Other\n\nUnrelated.\n';

let app: Fake;
let plugin: ThreadglyphPlugin;
let view: MarkdownView & { editor: { selection: [number, number] } };
let requests: AiRequest[];
let answers: (AiResult | (() => Promise<AiResult>))[];

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const files = (dir: string) => [...app.vault.adapter.files.keys()].filter((p) => p.startsWith(`${dir}/`));
const threads = (): ThreadRecord[] => files(THREADS_DIR).map((p) => JSON.parse(app.vault.adapter.files.get(p)!));
const panelEl = () => document.querySelector<HTMLElement>('.tg-panel')!;
const q = <T extends HTMLElement = HTMLElement>(sel: string) => panelEl()?.querySelector<T>(sel) ?? null;
const button = (label: string, root: ParentNode = panelEl()) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const command = (id: string) =>
  (plugin as unknown as { commands: { id: string; editorCheckCallback?: (...a: unknown[]) => boolean; checkCallback?: (checking: boolean) => boolean }[] }).commands.find((c) => c.id === id)!;

const objectAnswer = (over: Record<string, unknown> = {}): AiResult => ({
  ok: true,
  text: `\`\`\`json\n${JSON.stringify({ match: null, confidence: 'none', title: 'Eventual consistency', aliases: [], kind: 'concept', domains: ['systems'], essence: 'Replicas converge once writes stop.', key_ideas: ['Reads can be stale'], ...over })}\n\`\`\``,
});
const cardsAnswer: AiResult = { ok: true, text: '{"cards": [{"front": "What is eventual consistency?", "back": "Replicas converge once writes stop."}]}' };

async function commentOn(text: string, body: string) {
  const from = NOTE_TEXT.indexOf(text);
  view.editor.selection = [from, from + text.length];
  command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
  await flush();
  const input = q<HTMLTextAreaElement>('.tg-card-new textarea')!;
  input.value = body;
  input.dispatchEvent(new Event('input'));
  button('Comment')!.click();
  await flush();
}

beforeEach(async () => {
  notices.length = 0;
  requests = [];
  answers = [];
  app = new FakeApp();
  app.vault.adapter.files.set(NOTE, NOTE_TEXT);
  view = app.workspace.open(NOTE) as typeof view;
  plugin = new ThreadglyphPlugin(app as never, {} as never);
  const local: AiAdapter = {
    id: 'local',
    name: 'Local',
    detail: 'qwen3:8b',
    egress: 'local',
    capabilities: { text: true, images: false },
    ask: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (!next) return { ok: true, text: 'A plain reply.' };
      return typeof next === 'function' ? next() : next;
    },
  };
  plugin.adapterFactory = (settings) => (settings.aiEnabled ? [local] : []);
  await plugin.onload();
  await plugin.activatePanel();
  await flush();
});

afterEach(() => {
  plugin.onunload();
  document.body.innerHTML = '';
  openModals.length = 0;
});

const enable = async () => {
  plugin.settings.aiEnabled = true;
  plugin.settings.knowledgeEnabled = true;
  await plugin.refresh();
};

describe('knowledge workflows in the plugin', () => {
  it('does nothing while off: @knowledge is plain text', async () => {
    plugin.settings.aiEnabled = true;
    await plugin.refresh();
    await commentOn('Replicas converge', '@knowledge what is this?');
    expect(files(JOBS_DIR)).toEqual([]);
    expect(files('Knowledge')).toEqual([]);
    expect(q('.tg-knowledge')).toBeNull();
    expect(command('knowledge-queue').checkCallback!(true)).toBe(false);
    expect(command('knowledge-review').checkCallback!(true)).toBe(false);
  });

  it('offers @Knowledge and @Card in the mention menu when on', async () => {
    await enable();
    view.editor.selection = [NOTE_TEXT.indexOf('Replicas'), NOTE_TEXT.indexOf('Replicas') + 8];
    command('comment-on-selection').editorCheckCallback!(false, view.editor, view);
    await flush();
    const input = q<HTMLTextAreaElement>('.tg-card-new textarea')!;
    input.value = '@';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event('input'));
    const options = [...panelEl().querySelectorAll('.tg-mention-option')].map((o) => o.firstChild?.textContent);
    expect(options).toEqual(expect.arrayContaining(['@Knowledge', '@Card']));
    expect(panelEl().querySelector('.tg-mention-menu')!.textContent).toContain('stays on this computer');
  });

  it('turns an @card comment into an object, a card and a status row, writing only in the knowledge folder', async () => {
    await enable();
    answers = [objectAnswer(), cardsAnswer];
    await commentOn('Replicas converge', '@card what is this?');
    await flush();
    expect(notices).toContain('Threadglyph: queued for knowledge and cards.');
    const objectPath = 'Knowledge/Objects/Eventual consistency.md';
    const object = app.vault.adapter.files.get(objectPath)!;
    expect(field(object, 'source_refs')).toEqual(['[[Reading/Week 3]]']);
    expect(object).toContain('> Replicas converge');
    expect(app.vault.adapter.files.get('Knowledge/Knowledge.base')).toContain('Knowledge/Objects');
    const cards = files('Knowledge/Cards');
    expect(cards).toHaveLength(1);
    // The passage and its section went to the assistant; the note is unchanged.
    expect(requests[0].quote).toBe('Replicas converge');
    expect(requests[0].context?.text).toContain('# Consistency');
    expect(app.vault.adapter.files.get(NOTE)).toBe(NOTE_TEXT);
    // Thread records hold no quoted text; the private job does.
    expect(JSON.stringify(threads())).not.toContain('Replicas converge');
    expect(app.vault.adapter.files.get(files(JOBS_DIR)[0])).toContain('Replicas converge');

    await plugin.refresh();
    const row = q('.tg-knowledge-row')!;
    expect(row.textContent).toContain('1 card from “Eventual consistency”, in the card inbox');
    button('Open', row)!.click();
    button('Card', row)!.click();
    expect(app.workspace.opened).toEqual([objectPath, cards[0]]);
  });

  it('waits for the assistant the same comment asked, then includes its answer', async () => {
    await enable();
    answers = [{ ok: true, text: 'It means replicas agree later.' }, objectAnswer()];
    await commentOn('Replicas converge', '@Local explain @knowledge');
    expect(plugin.knowledge.all()[0].state).toBe('queued');
    expect(q('.tg-knowledge-row')!.textContent).toContain('Waiting for the answer');
    button('Send')!.click();
    await flush();
    button('Add to thread')?.click();
    await flush();
    await plugin.refresh();
    await flush();
    const job = plugin.knowledge.all()[0];
    expect(job.state).toBe('complete');
    expect(requests[1].messages.map((m) => m.body)).toContain('It means replicas agree later.');
  });

  it('runs once the assistant request is closed without an answer', async () => {
    await enable();
    answers = [objectAnswer()];
    await commentOn('Replicas converge', '@Local @knowledge');
    expect(plugin.knowledge.all()[0].state).toBe('queued');
    button('Cancel')?.click();
    (plugin as unknown as { ai: { closeAll(): void } }).ai.closeAll();
    await plugin.refresh();
    await flush();
    expect(plugin.knowledge.all()[0].state).toBe('complete');
  });

  it('queues a request added in an edit, and offers Update request after the request is edited', async () => {
    await enable();
    answers = [objectAnswer(), objectAnswer({ title: 'Convergence' })];
    await commentOn('Replicas converge', 'Interesting');
    expect(plugin.knowledge.all()).toEqual([]);
    const edit = async (body: string) => {
      [...panelEl().querySelectorAll<HTMLButtonElement>('.tg-message-action')].find((b) => b.textContent === 'Edit')!.click();
      await flush();
      const input = q<HTMLTextAreaElement>('textarea[data-draft-key^="edit:"]')!;
      input.value = body;
      input.dispatchEvent(new Event('input'));
      button('Save')!.click();
      await flush();
    };
    await edit('Interesting @knowledge');
    expect(plugin.knowledge.all()).toHaveLength(1);
    expect(plugin.knowledge.all()[0].state).toBe('complete');
    await edit('Convergence @knowledge');
    expect(plugin.knowledge.all()).toHaveLength(1);
    await plugin.refresh();
    button('Update request')!.click();
    await flush();
    expect(plugin.knowledge.all()[0]).toMatchObject({ revision: 2, state: 'complete', result: { objectTitle: 'Convergence' } });
    await edit('No longer a request');
    await plugin.refresh();
    button('Update request')!.click();
    await flush();
    expect(notices.at(-1)).toBe('That comment no longer says @knowledge or @card.');
  });

  it('opens the review form for a possible duplicate, and applies the chosen object', async () => {
    await enable();
    app.vault.adapter.dirs.add('Knowledge');
    app.vault.adapter.dirs.add('Knowledge/Objects');
    app.vault.adapter.files.set('Knowledge/Objects/Eventual consistency.md', renderObject({
      koId: 'ko-1',
      proposal: { title: 'Eventual consistency', aliases: [], kind: 'concept', domains: [], essence: 'Old essence.', keyIdeas: [], match: null, confidence: 'none' },
      learning: 'captured',
      evidence: { date: '2026-09-01', noteLink: 'Old', threadId: 'thread-old-1', quote: 'old', action: 'knowledge', instruction: '' },
    }));
    answers = [objectAnswer({ match: 'Eventual consistency', confidence: 'low' })];
    await commentOn('Replicas converge', '@knowledge');
    await plugin.refresh();
    expect(q('.tg-knowledge-row')!.textContent).toContain('may be “Eventual consistency”');
    expect(command('knowledge-review').checkCallback!(true)).toBe(true);
    button('Review')!.click();
    const modal = openModals.at(-1)!;
    expect(modal.titleEl.textContent).toBe('Review knowledge');
    const radios = [...modal.contentEl.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(['Knowledge/Objects/Eventual consistency.md', 'new']);
    expect(radios[0].checked).toBe(true);
    // Switching to "new" shows the editable fields; switching back hides them.
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change'));
    expect(modal.contentEl.querySelector('.tg-review-new')!.classList.contains('is-hidden')).toBe(false);
    const title = modal.contentEl.querySelector<HTMLInputElement>('.tg-review-new input')!;
    title.value = 'Eventual consistency (DB)';
    title.dispatchEvent(new Event('input'));
    const essence = modal.contentEl.querySelector<HTMLTextAreaElement>('.tg-review-new textarea')!;
    essence.value = 'My own words.';
    essence.dispatchEvent(new Event('input'));
    (modal.scope as unknown as { press(m: string[], k: string): unknown }).press(['Mod'], 'Enter');
    await flush();
    expect(app.vault.adapter.files.get('Knowledge/Objects/Eventual consistency (DB).md')).toContain('My own words.');
    expect(plugin.knowledge.all()[0].state).toBe('complete');
    expect(openModals).toHaveLength(0);
  });

  it('cancels a request from the review form, or leaves it for later', async () => {
    await enable();
    app.vault.adapter.dirs.add('Knowledge/Objects');
    app.vault.adapter.files.set('Knowledge/Objects/Eventual consistency.md', '---\ntitle: Eventual consistency\n---\n\n## Essence\n\nX\n');
    answers = [objectAnswer()];
    await commentOn('Replicas converge', '@knowledge');
    const id = plugin.knowledge.all()[0].id;
    plugin.openKnowledgeReview(id);
    button('Later', openModals.at(-1)!.contentEl)!.click();
    expect(plugin.knowledge.get(id)!.state).toBe('needs-review');
    plugin.openKnowledgeReview(id);
    button('Cancel request', openModals.at(-1)!.contentEl)!.click();
    await flush();
    expect(plugin.knowledge.get(id)!.state).toBe('canceled');
    plugin.openKnowledgeReview(id);
    plugin.openKnowledgeReview('nope');
    expect(openModals).toHaveLength(0);
  });

  it('lists every request in the queue, with retry, cancel, open and review', async () => {
    await enable();
    plugin.openKnowledgeQueue();
    expect(openModals.at(-1)!.contentEl.textContent).toContain('No knowledge requests yet');
    openModals.at(-1)!.close();

    answers = [{ ok: false, kind: 'busy', message: 'Busy.' }];
    await commentOn('Replicas converge', '@knowledge');
    expect(command('knowledge-queue').checkCallback!(true)).toBe(true);
    command('knowledge-queue').checkCallback!(false);
    let modal = openModals.at(-1)!;
    expect(modal.contentEl.textContent).toContain('Failed: Busy.');
    expect(modal.contentEl.textContent).toContain('Week 3 · @knowledge');
    answers = [objectAnswer()];
    button('Retry', modal.contentEl)!.click();
    await flush();
    expect(plugin.knowledge.all()[0].state).toBe('complete');
    (modal as unknown as { render(): void }).render();
    button('Open', modal.contentEl)!.click();
    expect(app.workspace.opened).toEqual(['Knowledge/Objects/Eventual consistency.md']);
    modal.close();

    answers = [() => new Promise(() => {})];
    await commentOn('Unrelated', '@knowledge');
    plugin.openKnowledgeQueue();
    modal = openModals.at(-1)!;
    button('Cancel', modal.contentEl)!.click();
    await flush();
    expect(plugin.knowledge.all()[1].state).toBe('canceled');
    modal.close();

    app.vault.adapter.files.set('Knowledge/Objects/Unrelated.md', '---\ntitle: Unrelated\n---\n');
    answers = [objectAnswer({ title: 'Unrelated' })];
    await commentOn('Replicas', '@knowledge');
    plugin.openKnowledgeQueue();
    modal = openModals.at(-1)!;
    button('Review', modal.contentEl)!.click();
    expect(openModals.at(-1)!.titleEl.textContent).toBe('Review knowledge');
  });

  it('retries and cancels from the thread card', async () => {
    await enable();
    answers = [{ ok: false, kind: 'busy', message: 'Busy.' }];
    await commentOn('Replicas converge', '@knowledge');
    await plugin.refresh();
    answers = [() => new Promise(() => {})];
    button('Retry')!.click();
    await flush();
    await plugin.refresh();
    button('Cancel')!.click();
    await flush();
    expect(plugin.knowledge.all()[0].state).toBe('canceled');
  });

  it('never writes outside the knowledge folder', async () => {
    const vault = (plugin as unknown as { knowledgeVault(): KnowledgeVault }).knowledgeVault();
    await expect(vault.create('Reading/Week 3.md', 'x')).rejects.toThrow('Refusing to write outside Knowledge/');
    await expect(vault.process('Elsewhere.md', (t) => t)).rejects.toThrow('Refusing');
    await expect(vault.process('Knowledge/Missing.md', (t) => t)).rejects.toThrow('is missing');
    expect(await vault.read('Nope.md')).toBeNull();
    expect(await vault.list('Nope')).toEqual([]);
    await vault.ensureFolder('Knowledge/Objects');
    await vault.ensureFolder('Knowledge/Objects');
    expect(app.vault.adapter.dirs.has('Knowledge/Objects')).toBe(true);
  });

  it('uses no assistant while AI is off, and sends to Anki only when that is on', async () => {
    plugin.settings.knowledgeEnabled = true;
    await plugin.refresh();
    await commentOn('Replicas converge', '@knowledge');
    expect(plugin.knowledge.all()[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('No assistant') });
    const host = (plugin.knowledge as unknown as { host: { delivery(): unknown } }).host;
    expect(host.delivery()).toBeNull();
    plugin.settings.ankiDelivery = true;
    expect(host.delivery()).not.toBeNull();
  });

  it('shows the knowledge settings at the end, off by default', async () => {
    const tab = (plugin as unknown as { settingTabs: { display(): void; containerEl: HTMLElement }[] }).settingTabs[0];
    tab.display();
    expect(tab.containerEl.textContent).toContain('Knowledge workflows');
    const toggles = [...tab.containerEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const [knowledgeToggle, ankiToggle] = toggles.slice(-2);
    expect(knowledgeToggle.checked).toBe(false);
    knowledgeToggle.checked = true;
    knowledgeToggle.dispatchEvent(new Event('change'));
    ankiToggle.checked = true;
    ankiToggle.dispatchEvent(new Event('change'));
    const texts = [...tab.containerEl.querySelectorAll<HTMLInputElement>('input:not([type])')].slice(-3);
    for (const [input, value] of [[texts[0], ' /Learn/ '], [texts[1], ''], [texts[2], 'Basic (and reversed card)']] as const) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    const selects = [...tab.containerEl.querySelectorAll<HTMLSelectElement>('select')];
    const knowledgeAssistant = selects.at(-1)!;
    knowledgeAssistant.value = 'gemini';
    knowledgeAssistant.dispatchEvent(new Event('change'));
    await flush();
    expect(plugin.settings).toMatchObject({
      knowledgeEnabled: true,
      ankiDelivery: true,
      knowledgeFolder: 'Learn',
      ankiDeck: 'Threadglyph Inbox',
      ankiNoteType: 'Basic (and reversed card)',
      knowledgeAssistant: 'gemini',
    });
    const folder = [...tab.containerEl.querySelectorAll<HTMLInputElement>('input:not([type])')].slice(-3)[0];
    folder.value = '/';
    folder.dispatchEvent(new Event('input'));
    await flush();
    expect(plugin.settings.knowledgeFolder).toBe('Knowledge');
  });
});
