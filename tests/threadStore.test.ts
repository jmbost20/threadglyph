import { describe, expect, it } from 'vitest';
import { captureTextAnchor } from '../src/anchor/textAnchor';
import { addReply, createThread, editMessage } from '../src/model/thread';
import { ANCHORS_DIR, THREADS_DIR, anchorPath, threadPath } from '../src/storage/paths';
import { ThreadStore } from '../src/storage/threadStore';
import { MemoryFs, fakeClock, human } from './helpers';

const note = 'Daily/2026-09-28.md';
const doc = 'Private diary line.\nA sentence worth discussing here.\n';

async function setup() {
  const fs = new MemoryFs();
  const clock = fakeClock();
  const store = new ThreadStore(fs, clock);
  const thread = createThread(note, human, 'Why this?', clock);
  const from = doc.indexOf('worth discussing');
  const anchor = captureTextAnchor(thread.id, note, doc, from, from + 'worth discussing'.length);
  await store.create(thread, anchor);
  return { fs, clock, store, thread, anchor };
}

describe('ThreadStore', () => {
  it('persists create/reply/edit and reloads the same ids and history', async () => {
    const { fs, clock, store, thread } = await setup();
    const replied = addReply(thread, human, 'Because.', clock);
    expect((await store.save(replied, thread.revision)).ok).toBe(true);
    const edited = editMessage(replied, replied.messages[1].id, 'Because, revised.', clock);
    expect((await store.save(edited, replied.revision)).ok).toBe(true);

    const reloaded = new ThreadStore(fs, clock);
    await reloaded.loadAll();
    const t = reloaded.get(thread.id);
    expect(t?.messages.map((m) => m.id)).toEqual(edited.messages.map((m) => m.id));
    expect(t?.messages[1]).toMatchObject({ body: 'Because, revised.', revisions: [{ body: 'Because.' }] });
    expect(reloaded.anchorFor(thread.id)?.quote).toBe('worth discussing');
    expect(reloaded.forNote(note)).toHaveLength(1);
    expect(reloaded.hasThreads(note)).toBe(true);
    expect(reloaded.loadProblems()).toEqual([]);
  });

  it('keeps quoted note text out of the tracked record', async () => {
    const { fs, thread } = await setup();
    const tracked = fs.files.get(threadPath(thread.id)) ?? '';
    const local = fs.files.get(anchorPath(thread.id)) ?? '';
    expect(tracked).not.toContain('worth discussing');
    expect(tracked).not.toContain('Private diary');
    expect(local).toContain('worth discussing');
    for (const path of fs.files.keys()) {
      expect(path.startsWith(`${THREADS_DIR}/`) || path.startsWith(`${ANCHORS_DIR}/`)).toBe(true);
    }
  });

  it('refuses a stale save, writes nothing and adopts the on-disk version', async () => {
    const { fs, clock, store, thread } = await setup();
    // Another writer (sync, second window) saves first.
    const external = addReply(thread, human, 'External reply', clock);
    await fs.write(threadPath(thread.id), JSON.stringify(external));
    const before = fs.files.get(threadPath(thread.id));

    const mine = addReply(thread, human, 'My reply', clock);
    const result = await store.save(mine, thread.revision);

    expect(result).toMatchObject({ ok: false, reason: 'conflict', current: { revision: 2 } });
    expect(fs.files.get(threadPath(thread.id))).toBe(before);
    expect(store.get(thread.id)?.messages.at(-1)?.body).toBe('External reply');
  });

  it('treats a deleted record as a conflict rather than recreating it', async () => {
    const { fs, clock, store, thread } = await setup();
    fs.files.delete(threadPath(thread.id));
    const result = await store.save(addReply(thread, human, 'x', clock), thread.revision);
    expect(result).toEqual({ ok: false, reason: 'conflict', current: null });
    expect(store.get(thread.id)).toBeUndefined();
    expect(fs.files.has(threadPath(thread.id))).toBe(false);
  });

  it('refuses to create a thread twice or with a foreign anchor', async () => {
    const { store, thread, anchor } = await setup();
    await expect(store.create(thread, anchor)).rejects.toThrow(/already exists/);
    await expect(store.create(thread, { ...anchor, threadId: 'other-thread' })).rejects.toThrow(/does not belong/);
  });

  it('reports malformed and mismatched files without rewriting them', async () => {
    const { fs, clock, thread } = await setup();
    fs.files.set(`${THREADS_DIR}/broken-00001.json`, '{ not json');
    fs.files.set(`${THREADS_DIR}/renamed-0001.json`, fs.files.get(threadPath(thread.id)) ?? '');
    fs.files.set(`${ANCHORS_DIR}/bad-anchor-01.json`, '{"schema":1}');
    fs.files.set(`${THREADS_DIR}/notes.txt`, 'ignored');
    const snapshot = new Map(fs.files);

    const store = new ThreadStore(fs, clock);
    await store.loadAll();

    expect(store.get(thread.id)).toBeDefined();
    const problems = store.loadProblems().map((p) => p.path).sort();
    expect(problems).toEqual([
      `${ANCHORS_DIR}/bad-anchor-01.json`,
      `${THREADS_DIR}/broken-00001.json`,
      `${THREADS_DIR}/renamed-0001.json`,
    ]);
    expect(fs.files).toEqual(snapshot);
  });

  it('reloads a single file after an external change or deletion', async () => {
    const { fs, clock, store, thread } = await setup();
    const external = addReply(thread, human, 'From another device', clock);
    await fs.write(threadPath(thread.id), JSON.stringify(external));
    expect((await store.reloadThreadFile(threadPath(thread.id)))?.revision).toBe(2);
    fs.files.delete(threadPath(thread.id));
    expect(await store.reloadThreadFile(threadPath(thread.id))).toBeNull();
    expect(store.get(thread.id)).toBeUndefined();
    expect(await store.reloadThreadFile('Some/other.json')).toBeNull();
  });

  it('follows note and folder renames for records and anchors', async () => {
    const { store, thread } = await setup();
    expect(await store.renameNote(note, 'Daily/renamed.md')).toEqual([]);
    expect(store.get(thread.id)?.notePath).toBe('Daily/renamed.md');
    expect(store.anchorFor(thread.id)?.notePath).toBe('Daily/renamed.md');

    expect(await store.renameNote('Daily', 'Journal')).toEqual([]);
    expect(store.get(thread.id)?.notePath).toBe('Journal/renamed.md');
    expect(store.forNote('Journal/renamed.md')).toHaveLength(1);
    // A sibling whose name merely starts with the same characters is not inside the folder.
    expect(await store.renameNote('Journ', 'X')).toEqual([]);
    expect(store.get(thread.id)?.notePath).toBe('Journal/renamed.md');
  });

  it('writes a replacement anchor on reattach without touching messages', async () => {
    const { fs, store, thread, anchor } = await setup();
    const trackedBefore = fs.files.get(threadPath(thread.id));
    await store.writeAnchor({ ...anchor, quote: 'A sentence' });
    expect(store.anchorFor(thread.id)?.quote).toBe('A sentence');
    expect(fs.files.get(threadPath(thread.id))).toBe(trackedBefore);
  });
});

describe('ThreadStore write serialization', () => {
  it('never lets two saves from the same revision both succeed', async () => {
    const { fs, clock, store, thread } = await setup();
    const a = addReply(thread, human, 'A', clock);
    const b = addReply(thread, human, 'B', clock);
    const [ra, rb] = await Promise.all([store.save(a, thread.revision), store.save(b, thread.revision)]);
    expect(ra.ok).toBe(true);
    expect(rb).toMatchObject({ ok: false, reason: 'conflict', current: { revision: 2 } });
    expect(JSON.parse(fs.files.get(threadPath(thread.id))!).messages.at(-1).body).toBe('A');
  });

  it('applies queued updates to the latest version', async () => {
    const { store, clock, thread } = await setup();
    const results = await Promise.all(
      ['one', 'two', 'three'].map((body) => store.update(thread.id, (t) => addReply(t, human, body, clock))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['Why this?', 'one', 'two', 'three']);
  });

  it('keeps the queue usable after a failed update', async () => {
    const { store, clock, thread } = await setup();
    await expect(
      store.update(thread.id, () => {
        throw new Error('bad change');
      }),
    ).rejects.toThrow('bad change');
    expect((await store.update(thread.id, (t) => addReply(t, human, 'after', clock))).ok).toBe(true);
    expect(await store.update('missing-thread', (t) => t)).toEqual({ ok: false, reason: 'missing', current: null });
  });
});
