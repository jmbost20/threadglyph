import { describe, expect, it } from 'vitest';
import type { HttpCall, HttpOutcome } from '../src/ai/http';
import type { AiRequest, AiResult } from '../src/ai/types';
import { AnkiConnect, cardTag, type CardDelivery, type Delivery } from '../src/knowledge/anki';
import { JOBS_DIR, KnowledgeCoordinator, statusView, type EnqueueInput, type KnowledgeHost } from '../src/knowledge/coordinator';
import {
  addCardLinks,
  addEvidence,
  addToList,
  advance,
  appendToSection,
  byName,
  cardSides,
  field,
  fileSafe,
  rankCandidates,
  renderCard,
  renderObject,
  setField,
  summaryOf,
  type EvidenceEntry,
} from '../src/knowledge/objects';
import { DEFAULT_KNOWLEDGE_SETTINGS, knowledgeBase, migrateKnowledgeSettings } from '../src/knowledge/settings';
import { instructionOf, requestedAction } from '../src/knowledge/trigger';
import { conceptTitle, excerptAround, localSection } from '../src/knowledge/source';
import type { KnowledgeJob, ObjectProposal } from '../src/knowledge/types';
import { CARD_PROMPT, OBJECT_PROMPT, cardRequest, objectRequest, parseCardsReply, parseObjectReply } from '../src/knowledge/worker';
import { buildPromptText, systemPromptFor } from '../src/ai/prompt';
import type { ThreadRecord } from '../src/model/types';

const proposal = (over: Partial<ObjectProposal> = {}): ObjectProposal => ({
  title: 'Eventual consistency',
  aliases: ['BASE consistency'],
  kind: 'concept',
  domains: ['distributed systems'],
  essence: 'Replicas may disagree for a while but converge when writes stop.',
  keyIdeas: ['Reads can be stale', 'Replicas converge'],
  match: null,
  confidence: 'none',
  cardType: 'concept',
  cardCount: 1,
  ambiguous: false,
  ...over,
});

const evidence = (over: Partial<EvidenceEntry> = {}): EvidenceEntry => ({
  date: '2026-10-01',
  noteLink: 'Reading/Week 3',
  threadId: 'thread-aaaaaaaa-1',
  quote: 'Replicas converge eventually.',
  action: 'knowledge',
  instruction: 'what does this mean?',
  ...over,
});

describe('requestedAction', () => {
  it('finds @card and @knowledge, with @card winning', () => {
    expect(requestedAction('@knowledge this')).toBe('knowledge');
    expect(requestedAction('Explain it @Card')).toBe('card');
    expect(requestedAction('@knowledge and @cards please')).toBe('card');
    expect(requestedAction('(@knowledge)')).toBe('knowledge');
  });

  it('ignores mentions in code, inline code, quotes and email-like text', () => {
    expect(requestedAction('```\n@card example\n```')).toBeNull();
    expect(requestedAction('write `@card` to ask')).toBeNull();
    expect(requestedAction('> @knowledge quoted\nnothing here')).toBeNull();
    expect(requestedAction('me@cards.com')).toBeNull();
    expect(requestedAction('plain comment')).toBeNull();
  });

  it('strips the mentions for the instruction', () => {
    expect(instructionOf('@card  what is   this?')).toBe('what is this?');
    expect(instructionOf('Explain (@knowledge)')).toBe('Explain ()');
  });
});

describe('object notes', () => {
  const text = renderObject({ koId: 'ko-1', proposal: proposal(), learning: 'captured', evidence: evidence() });

  it('renders frontmatter fields the Bases view and identity use', () => {
    expect(field(text, 'type')).toBe('knowledge-object');
    expect(field(text, 'title')).toBe('Eventual consistency');
    expect(field(text, 'aliases')).toEqual(['BASE consistency']);
    expect(field(text, 'learning_state')).toBe('captured');
    expect(field(text, 'source_refs')).toEqual(['[[Reading/Week 3]]']);
    expect(field(text, 'card_refs')).toEqual([]);
    expect(field(text, 'missing')).toBeNull();
    expect(text).toContain('## Essence\n\nReplicas may disagree');
    expect(text).toContain('> Replicas converge eventually.\n\n— [[Reading/Week 3]] · thread thread-a · 2026-10-01');
    expect(text).toContain('- 2026-10-01 · @knowledge from [[Reading/Week 3]]: “what does this mean?”');
  });

  it('renders an object with no key ideas, passage or instruction', () => {
    const bare = renderObject({ koId: 'ko-2', proposal: proposal({ keyIdeas: [] }), learning: 'discussed', evidence: evidence({ quote: null, instruction: '' }) });
    expect(bare).toContain('- (none yet)');
    expect(bare).toContain('> (image or no passage)');
    expect(bare).toContain('@knowledge from [[Reading/Week 3]]\n');
  });

  it('appends evidence, history and only new key ideas, leaving the essence alone', () => {
    const next = addEvidence(text, evidence({ noteLink: 'Other', quote: 'Second source.', action: 'card' }), ['Replicas converge', 'Conflicts need resolving']);
    expect(next).toContain('Replicas may disagree');
    expect(next.match(/Replicas converge$/gm)).toHaveLength(1);
    expect(next).toContain('- Conflicts need resolving\n\n## Evidence');
    expect(next).toContain('> Second source.\n\n— [[Other]]');
    expect(next).toContain('@card from [[Other]]');
    expect(next.indexOf('Second source')).toBeLessThan(next.indexOf('## Learning history'));
  });

  it('appends to a section, or adds it when the owner removed it', () => {
    expect(appendToSection('# T\n\n## Cards\n', 'Cards', '- [[a]]')).toBe('# T\n\n## Cards\n\n- [[a]]\n');
    expect(appendToSection('# T\n', 'Cards', '- [[a]]')).toBe('# T\n\n## Cards\n\n- [[a]]\n');
    expect(appendToSection('## A\n\nx\n\n## B\ny\n', 'a', 'z')).toBe('## A\n\nx\n\nz\n\n## B\ny\n');
    expect(addCardLinks(text, [])).toBe(text);
    expect(addCardLinks(text, ['Card 1'])).toContain('## Cards\n\n- [[Card 1]]\n');
  });

  it('sets fields, including over block lists the property editor writes', () => {
    const block = '---\ntitle: X\nsource_refs:\n  - "[[A]]"\n  - B\nupdated: 2026-09-01\n---\nbody\n';
    expect(field(block, 'source_refs')).toEqual(['[[A]]', 'B']);
    const added = addToList(block, 'source_refs', '[[C]]');
    expect(field(added, 'source_refs')).toEqual(['[[A]]', 'B', '[[C]]']);
    expect(added).toContain('updated: 2026-09-01\n---\nbody\n');
    expect(addToList(block, 'source_refs', 'B')).toBe(block);
    expect(field(setField(block, 'updated', '2026-10-01'), 'updated')).toBe('2026-10-01');
    expect(field(setField(block, 'new_field', 'yes'), 'new_field')).toBe('yes');
    expect(setField('no frontmatter', 'a', 'b')).toBe('no frontmatter');
    expect(field("---\nname: 'single'\nbad: \"unclosed\n---\n", 'name')).toBe('single');
    expect(field("---\nbad: \"unclosed\n---\n", 'bad')).toBe('unclose');
    expect(field(addToList('---\ntag: one\n---\n', 'tag', 'two'), 'tag')).toEqual(['one', 'two']);
    expect(field(addToList('---\nother: 1\n---\n', 'tag', 'two'), 'tag')).toEqual(['two']);
  });

  it('summarizes an object for retrieval, falling back to the file name', () => {
    expect(summaryOf('K/Objects/Eventual consistency.md', text)).toMatchObject({ title: 'Eventual consistency', aliases: ['BASE consistency'] });
    expect(summaryOf('K/Objects/Plain.md', 'no frontmatter')).toEqual({ path: 'K/Objects/Plain.md', title: 'Plain', aliases: [], essence: '' });
    expect(summaryOf('K/Objects/One.md', '---\naliases: solo\n---\n').aliases).toEqual(['solo']);
  });

  it('ranks candidates by named titles, then shared words', () => {
    const objects = [
      { path: 'a', title: 'Eventual consistency', aliases: [], essence: 'replicas converge' },
      { path: 'b', title: 'Caching', aliases: ['cache'], essence: 'store data closer to readers' },
      { path: 'c', title: 'Unrelated', aliases: [], essence: 'gardening tips' },
    ];
    const ranked = rankCandidates(objects, 'Why does the cache store data near readers? replicas');
    expect(ranked.map((o) => o.path)).toEqual(['b']);
    expect(rankCandidates(objects, 'eventual consistency of replicas').map((o) => o.path)[0]).toBe('a');
    expect(byName(objects, ' CACHE ')?.path).toBe('b');
    expect(byName(objects, 'nothing')).toBeNull();
  });

  it('renders cards and reads back edited sides', () => {
    const card = renderCard({ cardId: 'c1', card: { front: 'What is X?', back: 'A thing.' }, objectLink: 'X', deck: 'Inbox', date: '2026-10-01', sourceLink: 'Src' });
    expect(field(card, 'object')).toBe('[[X]]');
    expect(field(card, 'delivery')).toBe('inbox');
    expect(cardSides(card)).toEqual({ front: 'What is X?', back: 'A thing.' });
    expect(cardSides(card.replace('A thing.', 'Edited\nback.'))).toEqual({ front: 'What is X?', back: 'Edited\nback.' });
    expect(cardSides('## Front\n\nonly front\n')).toBeNull();
  });

  it('keeps titles file-safe and learning moving forward', () => {
    expect(fileSafe('What is: A/B? [x] #tag')).toBe('What is A B x tag');
    expect(fileSafe('///')).toBe('Untitled object');
    expect(advance('carded', 'discussed')).toBe('carded');
    expect(advance('captured', 'discussed')).toBe('discussed');
    expect(advance(undefined, 'captured')).toBe('captured');
  });
});

describe('worker replies', () => {
  it('reads an object proposal from a json block, tolerating raw line breaks', () => {
    const reply = 'Here:\n```json\n{"match": "Caching", "confidence": "high", "title": "Cache hit", "aliases": ["Cache hit", "hit"], "kind": "", "domains": ["systems"], "essence": "Found\tin cache.", "key_ideas": ["fast"]}\n```';
    const parsed = parseObjectReply(reply);
    expect(parsed).toEqual({
      ok: true,
      proposal: { title: 'Cache hit', aliases: ['hit'], kind: 'concept', domains: ['systems'], essence: 'Found\tin cache.', keyIdeas: ['fast'], match: 'Caching', confidence: 'high', cardType: 'concept', cardCount: 1, ambiguous: false },
    });
  });

  it('reads bare JSON and treats "null" matches as none', () => {
    const parsed = parseObjectReply('{"match": "null", "confidence": "high", "title": "T", "essence": "E", "keyIdeas": ["k"]}');
    expect(parsed.ok && parsed.proposal).toMatchObject({ match: null, confidence: 'none', keyIdeas: ['k'] });
  });

  it('refuses unreadable or incomplete answers', () => {
    expect(parseObjectReply('no json here')).toEqual({ ok: false, message: 'The assistant’s answer had no readable JSON.' });
    expect(parseObjectReply('```json\n{broken\n```')).toMatchObject({ ok: false });
    expect(parseObjectReply('```json\n[1, 2]\n```')).toMatchObject({ ok: false });
    expect(parseObjectReply('```json\n{"title": "T"}\n```')).toEqual({ ok: false, message: 'The assistant’s answer had no title or essence.' });
  });

  it('reads card plans and at most eight usable cards', () => {
    const plan = parseObjectReply('{"title": "T", "essence": "E", "card_type": "process", "card_count": "12", "ambiguous": true}');
    expect(plan.ok && plan.proposal).toMatchObject({ cardType: 'process', cardCount: 8, ambiguous: true });
    const fallback = parseObjectReply('{"title": "T", "essence": "E", "card_type": "poem", "card_count": "lots"}');
    expect(fallback.ok && fallback.proposal).toMatchObject({ cardType: 'concept', cardCount: 1, ambiguous: false });
    expect(parseObjectReply('{"title": "T", "essence": "E", "card_count": 0}').ok && true).toBe(true);
    const cards = Array.from({ length: 10 }, (_, i) => ({ front: `Q${i}`, back: `A${i}` }));
    expect(parseCardsReply(`\`\`\`json\n${JSON.stringify({ cards: [{ front: '', back: 'x' }, ...cards] })}\n\`\`\``)).toHaveLength(8);
    expect(parseCardsReply('nothing')).toEqual([]);
    expect(parseCardsReply('{"cards": "no"}')).toEqual([]);
  });

  it('builds requests with their own instructions and the candidates as data', () => {
    const job = { action: 'knowledge', quote: 'Q', context: { label: 'Section', text: 'S' }, request: 'R' } as KnowledgeJob;
    const req = objectRequest(job, 'Note', [], [{ path: 'K/Objects/X.md', title: 'X', essence: 'E' }]);
    expect(systemPromptFor(req)).toBe(OBJECT_PROMPT);
    expect(buildPromptText(req)).toContain('<vault-note path="K/Objects/X.md">\nTitle: X\nE\n</vault-note>');
    expect(req.messages).toEqual([{ author: 'Owner', origin: 'human', body: 'R' }]);
    const withThread = objectRequest(job, 'Note', [{ author: 'Local', ai: true, body: 'answer' }], []);
    expect(withThread.messages[0].origin).toBe('ai');
    const cards = cardRequest('K/Objects/X.md', 'object text', { type: 'concept', count: 1, note: '' }, '');
    expect(systemPromptFor(cards)).toBe(CARD_PROMPT);
    expect(cards.noteName).toBe('X');
    expect(cards.messages[0].body).toBe('Write about 1 concept card.');
    expect(cardRequest('K/Objects/X.md', 't', { type: 'application', count: 3, note: 'Use web examples.' }, 'cards please').messages[0].body)
      .toBe('Write about 3 application cards.\nUse web examples.\nThe comment said: cards please');
  });
});

describe('source excerpt and concept name', () => {
  const doc = '# Notes\n\n## Caching\n\nIntro line. A cache stores copies of data in fast memory. When data is there it is a hit.\n\n- A list item about cache use\n- Another item\n';
  const at = (text: string, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = doc.indexOf(text, i + 1);
    return [i, i + text.length] as const;
  };

  it('takes the sentence around the highlight, bolded, and the heading above it', () => {
    expect(excerptAround(doc, ...at('cache'))).toEqual({ excerpt: 'A **cache** stores copies of data in fast memory.', heading: 'Caching' });
    expect(excerptAround(doc, ...at('cache use')).excerpt).toBe('- A list item about **cache use**');
    expect(excerptAround('No heading here. Just text', 17, 21)).toEqual({ excerpt: '**Just** text', heading: null });
    expect(excerptAround('```\n# not a heading\n```\nWord here.', 25, 29).heading).toBeNull();
  });

  it('keeps a long sentence to a window around the highlight', () => {
    const long = `${'word '.repeat(300)}target ${'word '.repeat(300)}.`;
    const from = long.indexOf('target');
    const { excerpt } = excerptAround(long, from, from + 6);
    expect(excerpt).toContain('**target**');
    expect(excerpt.length).toBeLessThan(700);
  });

  it('uses the nearest heading of any level as the section, not a whole note under its title', () => {
    const note = '# Playground\n\nIntro with a passage.\n\n## Caching\n\nA cache stores data.\n\n## Other\n\nMore.\n';
    expect(localSection(note, note.indexOf('passage'))).toEqual({ label: 'The section “Playground”', text: '# Playground\n\nIntro with a passage.' });
    expect(localSection(note, note.indexOf('cache'))).toEqual({ label: 'The section “Caching”', text: '## Caching\n\nA cache stores data.' });
    expect(localSection('No headings at all.', 3)).toEqual({ label: 'The text around it', text: 'No headings at all.' });
    expect(localSection('```\n# code\n```\ntext', 18).label).toBe('The text around it');
    const long = `## Big\n\n${'x'.repeat(5000)}target${'y'.repeat(5000)}`;
    const big = localSection(long, long.indexOf('target'));
    expect(big.text).toContain('target');
    expect(big.text.startsWith('[…]')).toBe(true);
    expect(big.text.length).toBeLessThan(3100);
  });

  it('names the concept after a short highlight, not the note or section', () => {
    expect(conceptTitle('Knowledge playground', 'passage', 'Knowledge playground')).toEqual({ title: 'Passage', alias: null });
    expect(conceptTitle('Caching', 'store', 'Notes')).toEqual({ title: 'Store', alias: 'Caching' });
    expect(conceptTitle('Cache', 'caches', 'Notes')).toEqual({ title: 'Cache', alias: null });
    expect(conceptTitle('Eventual consistency', 'eventually consistent system', 'Notes')).toEqual({ title: 'Eventual consistency', alias: null });
    expect(conceptTitle('Anything', 'one two three four five six seven', 'Notes')).toEqual({ title: 'Anything', alias: null });
    expect(conceptTitle('Anything', null, 'Notes')).toEqual({ title: 'Anything', alias: null });
    expect(conceptTitle('Anything', '“…”', 'Notes')).toEqual({ title: 'Anything', alias: null });
  });
});

describe('settings', () => {
  it('defaults to off, local, and no Anki', () => {
    expect(migrateKnowledgeSettings({})).toEqual(DEFAULT_KNOWLEDGE_SETTINGS);
    expect(migrateKnowledgeSettings({ knowledgeEnabled: true, knowledgeFolder: '/Learn/', knowledgeAssistant: 'gemini', ankiDelivery: true, ankiDeck: ' D ' }))
      .toMatchObject({ knowledgeEnabled: true, knowledgeFolder: 'Learn', knowledgeAssistant: 'gemini', ankiDelivery: true, ankiDeck: 'D' });
    expect(migrateKnowledgeSettings({ knowledgeAssistant: 'other', knowledgeFolder: '/' }).knowledgeAssistant).toBe('local');
    expect(migrateKnowledgeSettings({ knowledgeFolder: '//' }).knowledgeFolder).toBe('Knowledge');
    expect(knowledgeBase('K')).toContain('file.inFolder("K/Objects")');
    expect(knowledgeBase('K')).not.toContain('Selected');
    const focused = knowledgeBase('K', ['K/Objects/Cache.md', 'K/Cards/Cache · 1.md']);
    expect(focused.indexOf('name: Selected')).toBeLessThan(focused.indexOf('name: Objects'));
    expect(focused).toContain('- file.path == "K/Cards/Cache · 1.md"');
    expect(focused).toContain('displayName: Concept');
  });
});

// ── Coordinator ────────────────────────────────────────────────────────────────

const FOLDER = 'Knowledge';
const PLAN = { type: 'concept' as const, count: 1, note: '' };

function makeHost(answers: (AiResult | ((r: AiRequest) => AiResult))[], opts: { thread?: Partial<ThreadRecord>; delivery?: CardDelivery | null; answered?: boolean } = {}) {
  const files = new Map<string, string>();
  const vaultFiles = new Map<string, string>();
  const folders = new Set<string>();
  const requests: AiRequest[] = [];
  let n = 0;
  let changes = 0;
  const thread: ThreadRecord = {
    schema: 1,
    id: 'thread-1111',
    notePath: 'Reading/Week 3.md',
    anchorKind: 'text',
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    revision: 1,
    messages: [{ id: 'msg-1', author: { kind: 'human', name: 'Jonah' }, origin: 'human', createdAt: '2026-10-01T00:00:00.000Z', body: '@knowledge what is this?', revisions: [] }],
    ...opts.thread,
  };
  const host: KnowledgeHost = {
    jobs: {
      read: async (p) => files.get(p) ?? null,
      write: async (p, d) => void files.set(p, d),
      list: async (d) => [...files.keys()].filter((p) => p.startsWith(`${d}/`)),
      ensureDir: async () => {},
    },
    vault: {
      list: async (folder) => [...vaultFiles.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/')),
      read: async (p) => vaultFiles.get(p) ?? null,
      create: async (p, t) => {
        if (vaultFiles.has(p)) throw new Error('exists');
        vaultFiles.set(p, t);
      },
      process: async (p, change) => {
        if (!vaultFiles.has(p)) throw new Error(`${p} is missing.`);
        vaultFiles.set(p, change(vaultFiles.get(p)!));
      },
      ensureFolder: async (p) => void folders.add(p),
    },
    folder: () => FOLDER,
    deck: () => 'Inbox',
    ask: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (!next) return null;
      return typeof next === 'function' ? next(request) : next;
    },
    thread: (id) => (id === thread.id ? thread : undefined),
    answered: () => opts.answered ?? true,
    delivery: () => opts.delivery ?? null,
    clock: { now: () => '2026-10-01T12:00:00.000Z', newId: () => `id-${String(++n).padStart(4, '0')}-abcdef` },
    changed: () => void changes++,
    enabled: () => true,
  };
  return { host, files, vaultFiles, folders, requests, thread, changes: () => changes };
}

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  action: 'knowledge',
  threadId: 'thread-1111',
  messageId: 'msg-1',
  notePath: 'Reading/Week 3.md',
  quote: 'Replicas converge eventually.',
  context: { label: 'The section “Consistency”', text: 'Replicas converge eventually. More text.' },
  request: '@knowledge what is this?',
  waitForAnswer: false,
  ...over,
});

const objectAnswer = (over: Record<string, unknown> = {}): AiResult => ({
  ok: true,
  text: `\`\`\`json\n${JSON.stringify({ match: null, confidence: 'none', title: 'Eventual consistency', aliases: [], kind: 'concept', domains: ['systems'], essence: 'Replicas converge.', key_ideas: ['Stale reads'], ...over })}\n\`\`\``,
});
const cardsAnswer = (n = 1): AiResult => ({ ok: true, text: JSON.stringify({ cards: Array.from({ length: n }, (_, i) => ({ front: `What is it ${i}?`, back: `It is ${i}.` })) }) });

async function settle(c: KnowledgeCoordinator) {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  return c;
}

describe('KnowledgeCoordinator', () => {
  it('creates a Knowledge Object from an @knowledge request, once', async () => {
    const h = makeHost([objectAnswer()]);
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    expect((await c.enqueue(input())).id).toBe(job.id);
    await settle(c);
    const done = c.get(job.id)!;
    expect(done.state).toBe('complete');
    expect(done.result).toMatchObject({ objectPath: 'Knowledge/Objects/Eventual consistency.md', created: true });
    const text = h.vaultFiles.get('Knowledge/Objects/Eventual consistency.md')!;
    expect(field(text, 'learning_state')).toBe('captured');
    expect(field(text, 'ko_id')).toBe('ko-id0002abcdef');
    expect(text).toContain('> Replicas converge eventually.');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].quote).toBe('Replicas converge eventually.');
    // The request comment goes without its @knowledge.
    expect(h.requests[0].messages[0].body).toBe('what is this?');
    expect(JSON.parse(h.files.get(`${JOBS_DIR}/${job.id}.json`)!).state).toBe('complete');
    expect(statusView(done, done.request)).toMatchObject({ text: 'Created “Eventual consistency”', stale: false, objectPath: 'Knowledge/Objects/Eventual consistency.md' });
    expect(statusView(done, '@knowledge edited')).toMatchObject({ stale: true });
    expect(h.changes()).toBeGreaterThan(0);
  });

  it('adds to an existing object the worker matches with high confidence', async () => {
    const h = makeHost([objectAnswer({ match: 'Eventual consistency', confidence: 'high', key_ideas: ['Converges later'] })], {
      thread: { messages: [
        { id: 'msg-1', author: { kind: 'human', name: 'J' }, origin: 'human', createdAt: 'x', body: '@knowledge', revisions: [] },
        { id: 'msg-2', author: { kind: 'ai', name: 'Local' }, origin: 'ai', createdAt: 'y', body: 'An answer.', revisions: [] },
      ] },
    });
    h.vaultFiles.set('Knowledge/Objects/Eventual consistency.md', renderObject({ koId: 'ko-old', proposal: proposal(), learning: 'carded', evidence: evidence() }));
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'complete', result: { created: false, objectTitle: 'Eventual consistency' } });
    const text = h.vaultFiles.get('Knowledge/Objects/Eventual consistency.md')!;
    expect(field(text, 'ko_id')).toBe('ko-old');
    expect(field(text, 'learning_state')).toBe('carded');
    expect(field(text, 'source_refs')).toEqual(['[[Reading/Week 3]]']);
    expect(text).toContain('- Converges later');
    expect(text.match(/> Replicas converge eventually\./g)).toHaveLength(2);
    expect(h.requests[0].vaultNotes?.[0].path).toBe('Knowledge/Objects/Eventual consistency.md');
    expect(h.requests[0].messages.map((m) => m.body)).toEqual(['@knowledge', 'An answer.']);
    expect(statusView(c.get(job.id)!, null).text).toBe('Added to “Eventual consistency”');
  });

  it('stops for review on a possible duplicate, then applies the owner’s choice', async () => {
    const h = makeHost([objectAnswer({ match: 'Eventual consistency', confidence: 'low' }), objectAnswer({ title: 'eventual CONSISTENCY' })]);
    h.vaultFiles.set('Knowledge/Objects/Eventual consistency.md', renderObject({ koId: 'ko-old', proposal: proposal(), learning: 'captured', evidence: evidence() }));
    const c = new KnowledgeCoordinator(h.host);
    const first = await c.enqueue(input());
    await settle(c);
    expect(c.get(first.id)).toMatchObject({ state: 'needs-review', reason: 'This may be “Eventual consistency”, which already exists.' });
    expect(c.get(first.id)!.candidates![0].path).toBe('Knowledge/Objects/Eventual consistency.md');
    expect(statusView(c.get(first.id)!, null).text).toContain('may be');
    await c.review(first.id, { kind: 'existing', path: 'Knowledge/Objects/Eventual consistency.md' });
    await settle(c);
    expect(c.get(first.id)).toMatchObject({ state: 'complete', result: { created: false } });

    // Same name, no match claimed: still reviewed; the owner makes a new, renamed object.
    const second = await c.enqueue(input({ messageId: 'msg-2' }));
    await settle(c);
    expect(c.get(second.id)!.state).toBe('needs-review');
    await c.review(second.id, { kind: 'new', title: 'Eventual consistency (databases)', essence: '' });
    await settle(c);
    expect(c.get(second.id)).toMatchObject({ state: 'complete', result: { created: true, objectTitle: 'Eventual consistency (databases)' } });
    expect(h.vaultFiles.get('Knowledge/Objects/Eventual consistency (databases).md')).toContain('Replicas converge.');
    // Reviewing a job that is not waiting does nothing.
    await c.review(second.id, { kind: 'new', title: 'x', essence: 'y' });
    expect(c.get(second.id)!.result!.objectTitle).toBe('Eventual consistency (databases)');
  });

  it('keeps a review open with the reason when applying it fails', async () => {
    const h = makeHost([objectAnswer({ match: 'Eventual consistency', confidence: 'low' })]);
    h.vaultFiles.set('Knowledge/Objects/Eventual consistency.md', renderObject({ koId: 'ko-old', proposal: proposal(), learning: 'captured', evidence: evidence() }));
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    await settle(c);
    await c.review(job.id, { kind: 'existing', path: 'Knowledge/Objects/Gone.md' });
    expect(c.get(job.id)).toMatchObject({ state: 'needs-review', reason: 'Knowledge/Objects/Gone.md is missing.' });
  });

  it('writes cards from the object, links them, and keeps them in the inbox without Anki', async () => {
    const h = makeHost([objectAnswer(), cardsAnswer(2)]);
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ action: 'card', request: '@card two cards', plan: { type: 'concept', count: 2, note: '' } }));
    await settle(c);
    const done = c.get(job.id)!;
    expect(done.state).toBe('complete');
    expect(done.result!.cardPaths).toEqual(['Knowledge/Cards/Eventual consistency · id0003abcd.md', 'Knowledge/Cards/Eventual consistency · id0004abcd.md']);
    // Cards are written from the published object, not the raw source.
    expect(h.requests[1].quote).toBeNull();
    expect(h.requests[1].vaultNotes?.[0].text).toContain('## Essence');
    expect(h.requests[1].messages[0].body).toBe('Write about 2 concept cards.\nThe comment said: two cards');
    const object = h.vaultFiles.get(done.result!.objectPath)!;
    expect(field(object, 'learning_state')).toBe('carded');
    expect(field(object, 'card_refs')).toHaveLength(2);
    expect(object).toContain('## Cards\n\n- [[Eventual consistency · id0003abcd]]');
    expect(statusView(done, null).text).toBe('2 cards from “Eventual consistency”, in the card inbox');
    expect(h.folders).toContain('Knowledge/Cards');
  });

  it('asks for the card choices in one form, then writes that many cards', async () => {
    const h = makeHost([objectAnswer({ card_type: 'application', card_count: 3, ambiguous: true }), cardsAnswer(3)]);
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ action: 'card', request: '@card', excerpt: 'A **cache** stores data.', heading: 'Caching' }));
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'needs-intake', suggest: 'new', reason: 'Choose the cards.', candidates: [], proposal: { cardType: 'application', cardCount: 3, ambiguous: true } });
    expect(statusView(c.get(job.id)!, null).text).toBe('Choose the cards.');
    await c.review(job.id, { kind: 'new', title: '', essence: '' }, { type: 'comparison', count: 3, note: 'versus a miss' });
    await settle(c);
    const done = c.get(job.id)!;
    expect(done.state).toBe('complete');
    expect(done.result!.cardPaths).toHaveLength(3);
    expect(h.requests[1].messages[0].body).toBe('Write about 3 comparison cards.\nversus a miss');
    // The evidence is the sentence around the highlight, linked to its section.
    const object = h.vaultFiles.get(done.result!.objectPath)!;
    expect(object).toContain('> A **cache** stores data.\n\n— [[Reading/Week 3#Caching|Week 3 › Caching]]');
  });

  it('asks again about the highlighted concept when the first answer was about something else', async () => {
    const h = makeHost([objectAnswer({ title: 'Knowledge playground', essence: 'About the note.' }), objectAnswer({ title: 'Passage (text)', essence: 'A short piece of text.' })]);
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ quote: 'passage', excerpt: 'Select a **passage** here.' }));
    await settle(c);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0].quote).toBe('Select a **passage** here.');
    expect(h.requests[1].messages.at(-1)!.body).toBe('The concept is “Passage”: the words in bold. Write the object for that concept only.');
    const object = h.vaultFiles.get(c.get(job.id)!.result!.objectPath)!;
    expect(field(object, 'title')).toBe('Passage');
    expect(object).toContain('A short piece of text.');
  });

  it('keeps the corrected name when the second answer fails, and pauses if turned off meanwhile', async () => {
    const h = makeHost([objectAnswer({ title: 'Caching', essence: 'About caching.' }), { ok: true, text: 'not json' }]);
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ quote: 'store' }));
    await settle(c);
    const object = h.vaultFiles.get(c.get(job.id)!.result!.objectPath)!;
    expect(field(object, 'title')).toBe('Store');
    expect(field(object, 'aliases')).toEqual(['Caching']);

    let on = true;
    h.host.enabled = () => on;
    let calls = 0;
    h.host.ask = async () => {
      if (++calls === 2) on = false;
      return objectAnswer({ title: 'Caching' });
    };
    const paused = await c.enqueue(input({ quote: 'store', messageId: 'msg-2' }));
    await settle(c);
    expect(c.get(paused.id)).toMatchObject({ state: 'queued', reason: 'Paused: knowledge workflows are off.' });
  });

  it('suggests the existing object in the card form when one matches', async () => {
    const h = makeHost([objectAnswer({ match: 'Eventual consistency', confidence: 'high' }), objectAnswer({ match: 'Eventual consistency', confidence: 'none' }), objectAnswer({ title: 'Eventual consistency' })]);
    h.vaultFiles.set('Knowledge/Objects/Eventual consistency.md', renderObject({ koId: 'ko-old', proposal: proposal(), learning: 'captured', evidence: evidence() }));
    const c = new KnowledgeCoordinator(h.host);
    const a = await c.enqueue(input({ action: 'card', request: '@card', quote: 'eventual' }));
    await settle(c);
    expect(c.get(a.id)).toMatchObject({ state: 'needs-intake', suggest: 'Knowledge/Objects/Eventual consistency.md', reason: 'Choose the cards. “Eventual consistency” already exists.' });
    const b = await c.enqueue(input({ action: 'card', request: '@card', messageId: 'msg-2', quote: 'eventual' }));
    await c.cancel(a.id);
    await settle(c);
    expect(c.get(b.id)!.suggest).toBe('new');
    await c.cancel(b.id);
    const d = await c.enqueue(input({ action: 'card', request: '@card', messageId: 'msg-3', quote: 'consistency' }));
    await settle(c);
    expect(c.get(d.id)!.suggest).toBe('Knowledge/Objects/Eventual consistency.md');
  });

  it('fails clearly when the assistant is off, errors or writes nothing usable, and retries from there', async () => {
    const h = makeHost([]);
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ action: 'card', plan: PLAN }));
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'failed', reason: expect.stringContaining('No assistant') });
    expect(statusView(c.get(job.id)!, null).text).toContain('Failed: No assistant');

    h.host.ask = async () => ({ ok: false, kind: 'busy', message: 'Busy.' });
    await c.retry(job.id);
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'failed', reason: 'Busy.' });

    h.host.ask = async () => ({ ok: true, text: 'no json' });
    await c.retry(job.id);
    await settle(c);
    expect(c.get(job.id)!.reason).toBe('The assistant’s answer had no readable JSON.');

    // The object is made, then cards fail: a retry makes no second object.
    const replies = [objectAnswer(), { ok: true, text: '{"cards": []}' } as AiResult, { ok: false, kind: 'busy', message: 'Busy.' } as AiResult, cardsAnswer(1)];
    h.host.ask = async () => replies.shift()!;
    await c.retry(job.id);
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'failed', reason: 'The assistant wrote no usable cards.' });
    await c.retry(job.id);
    await settle(c);
    expect(c.get(job.id)!.reason).toBe('Busy.');
    await c.retry(job.id);
    await settle(c);
    expect(c.get(job.id)!.state).toBe('complete');
    expect([...h.vaultFiles.keys()].filter((p) => p.includes('/Objects/'))).toHaveLength(1);
    // Retry only applies to stopped jobs.
    await c.retry(job.id);
    await c.retry('nope');
    expect(c.get(job.id)!.state).toBe('complete');
  });

  it('fails when the object vanished before its cards were written', async () => {
    const h = makeHost([objectAnswer(), cardsAnswer()]);
    const c = new KnowledgeCoordinator(h.host);
    const realCreate = h.host.vault.create;
    h.host.vault.create = async () => {};
    const job = await c.enqueue(input({ action: 'card', plan: PLAN }));
    await settle(c);
    expect(c.get(job.id)!.reason).toContain('is missing');
    h.host.vault.create = realCreate;
  });

  it('records an unexpected error as a failure', async () => {
    const h = makeHost([objectAnswer()]);
    h.host.vault.create = async () => {
      throw new Error('disk full');
    };
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'failed', reason: 'disk full' });
  });

  it('waits for the answer the comment also asked for', async () => {
    const h = makeHost([objectAnswer()], { answered: false });
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ waitForAnswer: true }));
    await settle(c);
    expect(c.get(job.id)!.state).toBe('queued');
    expect(statusView(c.get(job.id)!, null).text).toBe('Waiting for the answer, then queued');
    h.host.answered = () => true;
    c.kick();
    await settle(c);
    expect(c.get(job.id)!.state).toBe('complete');
  });

  it('resumes after a restart and skips unreadable job files', async () => {
    const h = makeHost([objectAnswer()], { answered: false });
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ waitForAnswer: true }));
    h.files.set(`${JOBS_DIR}/${job.id}.json`, JSON.stringify({ ...job, state: 'running', waitForAnswer: false }));
    h.files.set(`${JOBS_DIR}/broken.json`, '{');
    h.files.set(`${JOBS_DIR}/old.json`, JSON.stringify({ schema: 2 }));
    const restarted = new KnowledgeCoordinator(h.host);
    await restarted.load();
    expect(restarted.all()).toHaveLength(1);
    expect(restarted.get(job.id)!.state).toBe('queued');
    restarted.kick();
    await settle(restarted);
    expect(restarted.get(job.id)!.state).toBe('complete');
    expect(restarted.forThread('thread-1111')).toHaveLength(1);
  });

  it('cancels queued and running jobs, keeping what was made', async () => {
    let release: (r: AiResult) => void = () => {};
    const h = makeHost([() => objectAnswer()], { answered: false });
    const c = new KnowledgeCoordinator(h.host);
    const queued = await c.enqueue(input({ waitForAnswer: true }));
    await c.cancel(queued.id);
    expect(c.get(queued.id)).toMatchObject({ state: 'canceled', reason: 'Canceled.' });
    expect(statusView(c.get(queued.id)!, null).text).toBe('Canceled.');
    await c.cancel(queued.id);
    await c.cancel('nope');

    h.host.answered = () => true;
    h.host.ask = (_r, signal) => new Promise((resolve) => {
      release = resolve;
      signal.addEventListener('abort', () => resolve({ ok: false, kind: 'cancelled', message: 'Cancelled.' }));
    });
    const running = await c.enqueue(input({ messageId: 'msg-2' }));
    await settle(c);
    expect(c.get(running.id)!.state).toBe('running');
    expect(statusView(c.get(running.id)!, null).text).toBe('Reading the passage…');
    await c.cancel(running.id);
    release(objectAnswer());
    await settle(c);
    expect(c.get(running.id)!.state).toBe('canceled');

    // A canceled job can be retried.
    h.host.ask = async () => objectAnswer();
    await c.retry(running.id);
    await settle(c);
    expect(c.get(running.id)!.state).toBe('complete');
  });

  it('stops on unload without saving the step, and the resumed job finds the object it made', async () => {
    let release: (r: AiResult) => void = () => {};
    const h = makeHost([]);
    h.host.ask = () => new Promise((resolve) => {
      release = resolve;
    });
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    await settle(c);
    c.stop();
    release(objectAnswer());
    await settle(c);
    expect(JSON.parse(h.files.get(`${JOBS_DIR}/${job.id}.json`)!).state).toBe('running');
    c.kick();
    await c.enqueue(input({ messageId: 'msg-9' }));
    expect(c.all()).toHaveLength(1);

    // The object was made just before the stop; the restarted job reuses it.
    h.vaultFiles.set('Knowledge/Objects/Eventual consistency.md', setField(renderObject({ koId: 'ko-made', proposal: proposal(), learning: 'captured', evidence: evidence() }), 'created_by', `${job.id}#1`));
    h.host.ask = async () => objectAnswer();
    const restarted = new KnowledgeCoordinator(h.host);
    await restarted.load();
    restarted.kick();
    await settle(restarted);
    expect(restarted.get(job.id)).toMatchObject({ state: 'complete', result: { objectPath: 'Knowledge/Objects/Eventual consistency.md' } });
    expect([...h.vaultFiles.keys()].filter((p) => p.includes('/Objects/'))).toHaveLength(1);
  });

  it('adds evidence to an existing object once, even when a run is repeated', async () => {
    const h = makeHost([objectAnswer({ match: 'Eventual consistency', confidence: 'high' })]);
    h.vaultFiles.set('Knowledge/Objects/Eventual consistency.md', renderObject({ koId: 'ko-old', proposal: proposal(), learning: 'captured', evidence: evidence() }));
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    await settle(c);
    const once = h.vaultFiles.get('Knowledge/Objects/Eventual consistency.md')!;
    expect(once).toContain(`%%threadglyph ${job.id}#1%%`);
    // The same request published again (as after a stop just before its result was saved) changes nothing.
    const publish = (c as unknown as { publish(j: KnowledgeJob, t: unknown): Promise<KnowledgeJob> }).publish.bind(c);
    await publish({ ...c.get(job.id)!, result: undefined }, { kind: 'existing', path: 'Knowledge/Objects/Eventual consistency.md' });
    expect(h.vaultFiles.get('Knowledge/Objects/Eventual consistency.md')).toBe(once);
  });

  it('pauses instead of failing when the feature is turned off mid-run', async () => {
    let on = true;
    const h = makeHost([]);
    h.host.enabled = () => on;
    h.host.ask = async () => {
      on = false;
      return objectAnswer();
    };
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ action: 'card', plan: PLAN }));
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'queued', reason: 'Paused: knowledge workflows are off.' });
    on = true;
    const answersLeft = [objectAnswer(), cardsAnswer()];
    h.host.ask = async () => {
      const next = answersLeft.shift()!;
      if (!answersLeft.length) on = false;
      return next;
    };
    c.kick();
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'queued', reason: 'Paused: knowledge workflows are off.' });
    expect(c.get(job.id)!.result).toBeDefined();
  });

  it('links cards written before a restart', async () => {
    const h = makeHost([objectAnswer(), cardsAnswer(2)]);
    const c = new KnowledgeCoordinator(h.host);
    let cards = 0;
    const realCreate = h.host.vault.create;
    h.host.vault.create = async (p, t) => {
      if (p.includes('/Cards/') && ++cards === 2) throw new Error('disk full');
      await realCreate(p, t);
    };
    const job = await c.enqueue(input({ action: 'card', plan: PLAN }));
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'failed', reason: 'disk full', result: { cardPaths: [expect.stringContaining('id0003')] } });
    h.host.vault.create = realCreate;
    await c.retry(job.id);
    await settle(c);
    const object = h.vaultFiles.get(c.get(job.id)!.result!.objectPath)!;
    expect(field(object, 'card_refs')).toHaveLength(2);
    expect(object.match(/^- \[\[Eventual consistency · /gm)).toHaveLength(2);
  });

  it('runs and reviews nothing while knowledge workflows are off', async () => {
    let on = false;
    const h = makeHost([objectAnswer({ match: 'Eventual consistency', confidence: 'low' })]);
    h.host.enabled = () => on;
    h.vaultFiles.set('Knowledge/Objects/Eventual consistency.md', renderObject({ koId: 'ko-old', proposal: proposal(), learning: 'captured', evidence: evidence() }));
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    await settle(c);
    expect(c.get(job.id)!.state).toBe('queued');
    on = true;
    c.kick();
    await settle(c);
    expect(c.get(job.id)!.state).toBe('needs-review');
    on = false;
    await c.review(job.id, { kind: 'new', title: 'X', essence: 'Y' });
    expect(c.get(job.id)!.state).toBe('needs-review');
  });

  it('runs an edited request again as a new revision', async () => {
    const h = makeHost([objectAnswer(), objectAnswer({ title: 'Convergence' })]);
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input());
    await settle(c);
    await c.rerun(job.id, { action: 'knowledge', request: '@knowledge convergence', quote: 'they converge', context: null });
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ revision: 2, state: 'complete', request: '@knowledge convergence', result: { objectTitle: 'Convergence' } });
    await c.rerun('nope', { action: 'knowledge', request: '', quote: null, context: null });
  });

  it('delivers cards to Anki, waits when it is closed, and never sends one twice', async () => {
    const sent: string[] = [];
    let open = false;
    const delivery: CardDelivery = {
      deliver: async (card): Promise<Delivery> => {
        if (!open) return { ok: false, unavailable: true, message: 'Anki is not reachable.' };
        sent.push(card.cardId);
        return { ok: true, noteId: 100 + sent.length, existed: false };
      },
    };
    const h = makeHost([objectAnswer(), cardsAnswer(2)], { delivery });
    const c = new KnowledgeCoordinator(h.host);
    const job = await c.enqueue(input({ action: 'card', plan: PLAN }));
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'waiting-anki', reason: 'Anki is not reachable.' });
    expect(statusView(c.get(job.id)!, null).text).toBe('2 cards in the inbox; Anki is not reachable.');
    open = true;
    await c.retry(job.id);
    await settle(c);
    const done = c.get(job.id)!;
    expect(done.state).toBe('complete');
    expect(sent).toEqual(['id0003abcd', 'id0004abcd']);
    expect(Object.values(done.result!.delivered)).toEqual([101, 102]);
    const card = h.vaultFiles.get(done.result!.cardPaths[0])!;
    expect(field(card, 'delivery')).toBe('anki');
    expect(field(card, 'anki_note_id')).toBe('101');
    expect(statusView(done, null).text).toBe('2 cards from “Eventual consistency”, 2 in Anki');
  });

  it('fails on an Anki refusal and skips card files that lost their sides', async () => {
    const delivery: CardDelivery = { deliver: async () => ({ ok: false, unavailable: false, message: 'Anki refused the card: no deck' }) };
    const h = makeHost([objectAnswer(), cardsAnswer(2)], { delivery });
    const c = new KnowledgeCoordinator(h.host);
    const realCreate = h.host.vault.create;
    let made = 0;
    h.host.vault.create = async (p, t) => realCreate(p, p.includes('/Cards/') && made++ === 0 ? 'edited away' : t);
    const job = await c.enqueue(input({ action: 'card', plan: PLAN }));
    await settle(c);
    expect(c.get(job.id)).toMatchObject({ state: 'failed', reason: 'Anki refused the card: no deck' });
  });

  it('describes every state for the card', () => {
    const base = { id: 'j', action: 'card', request: 'r', state: 'running', waitForAnswer: false, result: { objectPath: 'o', objectTitle: 'O', created: true, cardPaths: [], delivered: {} } } as unknown as KnowledgeJob;
    expect(statusView(base, null).text).toBe('Writing cards for “O”…');
    expect(statusView({ ...base, action: 'knowledge' }, null).text).toBe('Saving…');
    expect(statusView({ ...base, state: 'complete', result: undefined }, null).text).toBe('Done');
    expect(statusView({ ...base, state: 'queued' }, null).text).toBe('Queued');
    expect(statusView({ ...base, state: 'needs-review', reason: undefined }, null).text).toBe('Needs your review');
    expect(statusView({ ...base, state: 'waiting-anki', reason: undefined }, null).text).toBe('0 cards in the inbox; waiting for Anki');
    expect(statusView({ ...base, state: 'failed', reason: undefined }, null).text).toBe('Failed: unknown error');
    expect(statusView({ ...base, state: 'canceled', reason: undefined }, null).text).toBe('Canceled');
    expect(statusView({ ...base, state: 'running' }, 'changed').stale).toBe(false);
  });
});

describe('AnkiConnect', () => {
  const card = { cardId: 'c1', front: 'Q', back: 'A', deck: 'Inbox' };
  const signal = new AbortController().signal;
  const fake = (replies: (HttpOutcome | ((call: HttpCall) => HttpOutcome))[]) => {
    const calls: { action: string; params: Record<string, unknown> }[] = [];
    const http = async (call: HttpCall): Promise<HttpOutcome> => {
      calls.push(JSON.parse(call.body!));
      const next = replies.shift()!;
      return typeof next === 'function' ? next(call) : next;
    };
    return { http, calls };
  };
  const ok = (result: unknown): HttpOutcome => ({ ok: true, status: 200, text: JSON.stringify({ result, error: null }) });

  it('adds a tagged note once, finding it on a retry', async () => {
    const { http, calls } = fake([ok([]), ok(1), ok(555)]);
    expect(await new AnkiConnect(http).deliver(card, signal)).toEqual({ ok: true, noteId: 555, existed: false });
    expect(calls.map((c) => c.action)).toEqual(['findNotes', 'createDeck', 'addNote']);
    expect(calls[0].params.query).toBe(`"tag:${cardTag('c1')}"`);
    expect(calls[2].params.note).toMatchObject({ deckName: 'Inbox', modelName: 'Basic', fields: { Front: 'Q', Back: 'A' }, tags: ['threadglyph', 'threadglyph::c1'] });
    const again = fake([ok([555])]);
    expect(await new AnkiConnect(again.http).deliver(card, signal)).toEqual({ ok: true, noteId: 555, existed: true });
  });

  it('reports Anki closed, refusals and odd answers', async () => {
    expect(await new AnkiConnect(fake([{ ok: false, reason: 'network', message: 'ECONNREFUSED' }]).http).deliver(card, signal)).toMatchObject({ ok: false, unavailable: true });
    expect(await new AnkiConnect(fake([{ ok: true, status: 200, text: 'html' }]).http).deliver(card, signal)).toMatchObject({ ok: false, unavailable: true });
    expect(await new AnkiConnect(fake([ok([]), { ok: true, status: 200, text: JSON.stringify({ result: null, error: 'deck x' }) }]).http).deliver(card, signal))
      .toEqual({ ok: false, unavailable: false, message: 'Anki refused the card: deck x' });
    expect(await new AnkiConnect(fake([ok([]), ok(1), ok(null)]).http).deliver(card, signal)).toMatchObject({ ok: false, message: 'Anki did not return the new note.' });
    expect(await new AnkiConnect(fake([ok([]), ok(1), { ok: false, reason: 'timeout', message: 'slow' }]).http).deliver(card, signal)).toMatchObject({ unavailable: true });
    expect(await new AnkiConnect(fake([ok('weird'), ok(1), ok(7)]).http, 'http://x', 'Basic (and reversed)').deliver(card, signal)).toMatchObject({ ok: true, noteId: 7 });
  });
});
