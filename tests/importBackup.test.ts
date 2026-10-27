import { describe, expect, it } from 'vitest';
import { ThreadController } from '../src/controller';
import {
  codeRanges,
  entryMessage,
  importedThread,
  legacyAuthor,
  legacyDate,
  parseEntry,
  parseLegacyComments,
  planImport,
} from '../src/import/inlineComments';
import { resolveTextAnchor } from '../src/anchor/textAnchor';
import { EXPORTS_DIR, buildExport, exportFileName, parseExport } from '../src/storage/backup';
import { ANCHORS_DIR, THREADS_DIR } from '../src/storage/paths';
import { ThreadStore } from '../src/storage/threadStore';
import { MemoryFs, fakeClock, human } from './helpers';

// Synthetic example in the old plugin's markup; no real note content.
const NOTE = [
  '# Garden plan',
  'We should {==plant the tomatoes early==}{>>user|2026-09-16 14:20|question: Is April too soon?<<}' +
    '{>>Local|2026-09-16 14:21|reply: Frost can still hit in April; wait until mid-May.<<}' +
    '{>>user|2026-09-16 14:25|react: 👍 #1<<} this year.',
  'Also {==compost the leaves==}{>>Codex|2026-09-17|note: Shred them ‹‹first››.<<}{>>user|2026-09-17|resolve: <<}.',
  'Only a reaction: {==ignored==}{>>user|2026-09-18|react: 👍 #0<<}',
  'Legacy {==short form==}{>>someone|2026-09-18: Old style<<}{>>no metadata at all<<}',
  'Suggestions {==too wordy==}{>>Claude|bad date|suggest: shorter<<}{>>Claude|2026-09-19|accepted: shorter<<}{>>Claude|2026-09-19|declined: other<<}',
].join('\n');

const people = { assistants: ['Claude', 'Codex', 'Gemini', 'Local'], you: 'Jonah' };

describe('inline comment import', () => {
  it('parses passages, entries and resolved state from the old markup', () => {
    const found = parseLegacyComments(NOTE);
    expect(found.map((t) => t.quote)).toEqual(['plant the tomatoes early', 'compost the leaves', 'ignored', 'short form', 'too wordy']);
    for (const t of found) expect(NOTE.slice(t.from, t.to)).toBe(t.quote);
    expect(found[0].entries[1]).toEqual({ author: 'Local', date: '2026-09-16 14:21', type: 'reply', text: 'Frost can still hit in April; wait until mid-May.' });
    expect(found.map((t) => t.resolved)).toEqual([false, true, false, false, false]);
    expect(found[1].entries[0].text).toBe('Shred them <<first>>.');
    expect(parseEntry('someone|2026-09-18: Old style')).toEqual({ author: 'someone', date: '2026-09-18', type: 'note', text: 'Old style' });
    expect(parseEntry(' bare ')).toEqual({ author: 'unknown', date: '', type: 'note', text: 'bare' });
  });

  it('keeps the conversation and drops opinion tags, reactions and resolve markers', () => {
    expect(entryMessage({ author: 'a', date: '', type: 'question', text: 'Why?' })).toEqual({ body: 'Why?' });
    expect(entryMessage({ author: 'a', date: '', type: 'react', text: '👍 #0' })).toBeNull();
    expect(entryMessage({ author: 'a', date: '', type: 'resolve', text: '' })).toBeNull();
    expect(entryMessage({ author: 'a', date: '', type: 'agree', text: '  ' })).toBeNull();
    expect(entryMessage({ author: 'a', date: '', type: 'suggest', text: 'x' })).toEqual({ body: 'Suggested wording: x' });
    expect(entryMessage({ author: 'a', date: '', type: 'accepted', text: 'x' })?.body).toBe('Suggested wording (accepted): x');
    expect(entryMessage({ author: 'a', date: '', type: 'declined', text: 'x' })?.body).toBe('Suggested wording (declined): x');
  });

  it('maps authors and dates', () => {
    expect(legacyAuthor('claude', people)).toEqual({ kind: 'ai', name: 'claude' });
    expect(legacyAuthor('user', people)).toEqual({ kind: 'human', name: 'Jonah' });
    expect(legacyAuthor('unknown', people)).toEqual({ kind: 'human', name: 'Jonah' });
    expect(legacyAuthor('Sam', people)).toEqual({ kind: 'human', name: 'Sam' });
    expect(legacyDate('2026-09-16')).toBe(new Date('2026-09-16T00:00:00').toISOString());
    expect(legacyDate('2026-09-16 14:20')).toBe(new Date('2026-09-16T14:20:00').toISOString());
    expect(legacyDate('2026-99-99')).toBeNull();
    expect(legacyDate('yesterday')).toBeNull();
  });

  it('builds a thread in order, with AI attribution and resolved status', () => {
    const [tomatoes, compost, reaction, , wordy] = parseLegacyComments(NOTE);
    const clock = fakeClock();
    const t = importedThread('Garden.md', tomatoes, people, clock)!;
    expect(t.messages.map((m) => [m.author.name, m.origin, m.body])).toEqual([
      ['Jonah', 'human', 'Is April too soon?'],
      ['Local', 'ai', 'Frost can still hit in April; wait until mid-May.'],
    ]);
    expect(t).toMatchObject({ notePath: 'Garden.md', anchorKind: 'text', status: 'open', revision: 1 });
    expect(importedThread('Garden.md', compost, people, clock)!.status).toBe('resolved');
    expect(importedThread('Garden.md', reaction, people, clock)).toBeNull();
    const w = importedThread('Garden.md', wordy, people, clock)!;
    const times = w.messages.map((m) => m.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('dates an entry with a missing or unreadable date from its neighbours, not the import time', () => {
    const at = (iso: string) => new Date(iso).toISOString();
    const importClock = { now: () => '2026-10-27T17:00:00.000Z', newId: fakeClock().newId };
    const dates = (doc: string) =>
      importedThread('n.md', parseLegacyComments(doc)[0], people, importClock)!.messages.map((m) => m.createdAt);

    // Undated in the middle: takes the time before it; later dated messages keep their own dates.
    expect(dates('{==p==}{>>Ann|2026-09-16 10:00|note: one<<}{>>Bob|yesterday|note: two<<}{>>Ann|2026-09-17 10:00|note: three<<}'))
      .toEqual([at('2026-09-16T10:00:00'), at('2026-09-16T10:00:00'), at('2026-09-17T10:00:00')]);
    // Undated first: takes the next dated time.
    expect(dates('{==p==}{>>Bob|soon|note: one<<}{>>Ann|2026-09-17 10:00|note: two<<}'))
      .toEqual([at('2026-09-17T10:00:00'), at('2026-09-17T10:00:00')]);
    // Dates on reactions and resolves count as neighbours too (Gitar on #43).
    expect(dates('{==p==}{>>Bob|soon|note: one<<}{>>user|2026-09-17|resolve: <<}'))
      .toEqual([at('2026-09-17T00:00:00')]);
    expect(dates('{==p==}{>>Bob|soon|note: one<<}{>>Ann|2026-09-16|react: 👍<<}{>>Ann|2026-09-20|note: two<<}'))
      .toEqual([at('2026-09-16T00:00:00'), at('2026-09-20T00:00:00')]);
    // No readable dates at all: the import time.
    expect(dates('{==p==}{>>Bob|soon|note: one<<}{>>Ann|later|note: two<<}'))
      .toEqual(['2026-10-27T17:00:00.000Z', '2026-10-27T17:00:00.000Z']);
  });

  it('skips markup shown as an example inside code', () => {
    const doc = [
      'Write `{==text==}{>>you|2026-09-16|note: hi<<}` to comment.',
      '```md',
      '{==in a fence==}{>>you|2026-09-16|note: example<<}',
      '```',
      'A {==real one==}{>>Ann|2026-09-16|note: keep me<<}.',
      '~~~~',
      '{==unclosed fence==}{>>you|2026-09-16|note: example<<}',
    ].join('\n');
    expect(parseLegacyComments(doc).map((t) => t.quote)).toEqual(['real one']);
    expect(planImport(doc, []).map((p) => p.legacy.quote)).toEqual(['real one']);
  });

  it('finds code: inline spans, fences closed by a long enough marker of the same kind, and an unclosed fence', () => {
    const doc = 'a `b` c\n````\n```\nx\n````\nafter `d`\n~~~\ntail';
    const spans = codeRanges(doc).map(([from, to]) => doc.slice(from, to));
    expect(spans).toEqual(['`b`', '````\n```\nx\n````', '`d`', '~~~\ntail']);
  });

  it('closes a fence only on a bare marker, and a code span only at a backtick run of its own length (Gitar on #45)', () => {
    const fence = ['```', 'code', '```js', 'more', '```', 'A {==real==}{>>Ann|2026-09-16|note: keep<<}'].join('\n');
    expect(parseLegacyComments(fence).map((t) => t.quote)).toEqual(['real']);
    const doubled = 'Write `` {==x==}{>>u|2026-09-16|note: use `code`<<} `` to comment. {==y==}{>>Ann|2026-09-16|note: real<<}';
    expect(parseLegacyComments(doubled).map((t) => t.quote)).toEqual(['y']);
    const wrapped = 'Use `{==a==}{>>u|2026-09-16|note:\nb<<}` here.\n\nNot `closed\n\nhere {==z==}{>>Ann|2026-09-16|note: real<<}';
    expect(parseLegacyComments(wrapped).map((t) => t.quote)).toEqual(['z']);
    // A span cannot run into a fence that starts before it closes.
    expect(codeRanges('a `b\n```\nc`\n```').map(([f, t]) => [f, t])).toEqual([[5, 15]]);
  });

  it('plans an import and recognises threads that were already imported', () => {
    const plan = planImport(NOTE, [{ quote: 'compost the leaves', firstBody: 'Shred them <<first>>.' }]);
    expect(plan.map((p) => [p.legacy.quote, p.status, p.messages])).toEqual([
      ['plant the tomatoes early', 'new', 2],
      ['compost the leaves', 'already-imported', 1],
      ['ignored', 'nothing-to-import', 0],
      ['short form', 'new', 2],
      ['too wordy', 'new', 3],
    ]);
  });

  it('imports through the controller without touching the note, anchored inside the markup', async () => {
    const fs = new MemoryFs();
    const store = new ThreadStore(fs, fakeClock());
    const ctl = new ThreadController(store, () => human, fakeClock());
    const [tomatoes, , reaction] = parseLegacyComments(NOTE);
    expect(await ctl.importLegacy('Garden.md', NOTE, tomatoes, people)).toEqual({ ok: true });
    expect(await ctl.importLegacy('Garden.md', NOTE, reaction, people)).toEqual({ ok: false, message: 'That comment has no messages to import.' });
    const [thread] = store.forNote('Garden.md');
    const anchor = store.anchorFor(thread.id)!;
    expect(resolveTextAnchor(NOTE, anchor)).toEqual({ status: 'found', from: tomatoes.from, to: tomatoes.to });
    // Tracked records carry no note text.
    const tracked = [...fs.files].filter(([p]) => p.startsWith(THREADS_DIR)).map(([, v]) => v).join('');
    expect(tracked).not.toContain('plant the tomatoes early');
    expect([...fs.files.keys()].some((p) => p.startsWith(ANCHORS_DIR))).toBe(true);
  });
});

describe('backups', () => {
  async function storeWithThread() {
    const fs = new MemoryFs();
    const store = new ThreadStore(fs, fakeClock());
    const ctl = new ThreadController(store, () => human, fakeClock());
    ctl.beginThread('n.md', 'Some passage here.', 5, 12);
    await ctl.commitThread('Keep this');
    return { fs, store };
  }

  it('round-trips threads and anchors, and restores only what is missing', async () => {
    const { store } = await storeWithThread();
    const { threads, anchors } = store.snapshot();
    const raw = buildExport(threads, anchors, new Date('2026-09-29T12:00:00Z'));
    const parsed = parseExport(raw);
    expect(parsed).toMatchObject({ ok: true, value: { invalid: 0 } });
    if (!parsed.ok) throw new Error('unreachable');

    expect(await store.restore(parsed.value.threads[0], parsed.value.anchors.get(threads[0].id))).toBe('exists');
    const fresh = new ThreadStore(new MemoryFs(), fakeClock());
    expect(await fresh.restore(parsed.value.threads[0], parsed.value.anchors.get(threads[0].id))).toBe('restored');
    expect(fresh.get(threads[0].id)?.messages[0].body).toBe('Keep this');
    expect(fresh.anchorFor(threads[0].id)?.quote).toBe('passage');
    const noAnchor = new ThreadStore(new MemoryFs(), fakeClock());
    expect(await noAnchor.restore(parsed.value.threads[0], undefined)).toBe('restored');
    expect(noAnchor.anchorFor(threads[0].id)).toBeUndefined();
  });

  it('never restores over a thread file that exists on disk but is not loaded', async () => {
    const { fs, store } = await storeWithThread();
    const [thread] = store.snapshot().threads;
    const reloaded = new ThreadStore(fs, fakeClock());
    expect(await reloaded.restore({ ...thread, messages: [] }, undefined)).toBe('exists');
  });

  it('rejects files that are not valid backups and counts invalid records', () => {
    expect(parseExport('nope')).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') });
    expect(parseExport('null')).toEqual({ ok: false, error: 'not a Threadglyph backup' });
    expect(parseExport('{"format":"threadglyph-export","version":9}')).toEqual({ ok: false, error: 'unsupported backup version 9' });
    expect(parseExport('{"format":"threadglyph-export","version":1}')).toEqual({ ok: false, error: 'backup is missing its records' });
    const bad = parseExport('{"format":"threadglyph-export","version":1,"threads":[{"id":"../x"}],"anchors":[{}]}');
    expect(bad).toMatchObject({ ok: true, value: { threads: [], invalid: 2 } });
  });

  it('writes backups to the local-only folder with a sortable name', () => {
    expect(exportFileName(new Date('2026-09-29T12:34:56.789Z'))).toBe(`${EXPORTS_DIR}/threadglyph-2026-09-29T12-34-56-789Z.json`);
    expect(EXPORTS_DIR.startsWith('.threadglyph/')).toBe(true);
  });
});
