import { describe, expect, it } from 'vitest';
import { CONFLICT_MESSAGE, ThreadController } from '../src/controller';
import { addReply, editMessage } from '../src/model/thread';
import { threadPath } from '../src/storage/paths';
import { ThreadStore } from '../src/storage/threadStore';
import { draftKey } from '../src/ui/viewModel';
import { MemoryFs, fakeClock, human } from './helpers';

const note = 'Notes/topic.md';
const doc = 'Some context. The claim under discussion. More text.\n';
const range = (s: string) => [doc.indexOf(s), doc.indexOf(s) + s.length] as const;

async function setup() {
  const fs = new MemoryFs();
  const clock = fakeClock();
  const store = new ThreadStore(fs, clock);
  const ctl = new ThreadController(store, () => human, clock);
  expect(ctl.beginThread(note, doc, ...range('The claim'))).toEqual({ ok: true });
  const created = await ctl.commitThread('Is this right?');
  if (!created.ok || !created.thread) throw new Error('setup failed');
  return { fs, clock, store, ctl, thread: created.thread };
}

describe('ThreadController', () => {
  it('creates a thread from a pending selection and attaches its anchor', async () => {
    const { store, ctl, thread } = await setup();
    expect(ctl.pending).toBeNull();
    expect(store.anchorFor(thread.id)).toMatchObject({ threadId: thread.id, quote: 'The claim' });
    expect(store.forNote(note)).toHaveLength(1);
  });

  it('rejects invalid selections and commits without a selection', async () => {
    const ctl = new ThreadController(new ThreadStore(new MemoryFs()), () => human, fakeClock());
    expect(ctl.beginThread(note, doc, 5, 5).ok).toBe(false);
    expect(await ctl.commitThread('x')).toMatchObject({ ok: false });
  });

  it('reports an empty first comment without losing the pending selection', async () => {
    const ctl = new ThreadController(new ThreadStore(new MemoryFs()), () => human, fakeClock());
    ctl.beginThread(note, doc, ...range('claim'));
    expect(await ctl.commitThread('   ')).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
    expect(ctl.pending).not.toBeNull();
  });

  it('cancelling a new thread clears its draft', async () => {
    const ctl = new ThreadController(new ThreadStore(new MemoryFs()), () => human, fakeClock());
    ctl.beginThread(note, doc, ...range('claim'));
    ctl.drafts.set(draftKey.newThread(note), 'half written');
    ctl.cancelThread();
    expect(ctl.pending).toBeNull();
    expect(ctl.drafts.size).toBe(0);
  });

  it('replies, edits and resolves through the store', async () => {
    const { store, ctl, thread } = await setup();
    expect(await ctl.reply(thread.id, 'Yes.')).toEqual({ ok: true });
    const replyId = store.get(thread.id)!.messages[1].id;

    ctl.startEdit(thread.id, replyId);
    const key = draftKey.edit(thread.id, replyId);
    expect(ctl.editing.has(key)).toBe(true);
    expect(ctl.drafts.get(key)).toBe('Yes.');
    expect(await ctl.saveEdit(thread.id, replyId, 'Yes, with caveats.')).toEqual({ ok: true });
    expect(ctl.editing.has(key)).toBe(false);
    expect(store.get(thread.id)!.messages[1]).toMatchObject({ id: replyId, body: 'Yes, with caveats.' });

    expect(await ctl.setResolved(thread.id, true)).toEqual({ ok: true });
    expect(store.get(thread.id)!.status).toBe('resolved');
    expect(await ctl.setResolved(thread.id, true)).toEqual({ ok: true });
    expect(await ctl.setResolved(thread.id, false)).toEqual({ ok: true });
    expect(store.get(thread.id)!.status).toBe('open');
  });

  it('cancelling an edit leaves the message unchanged and drops the draft', async () => {
    const { store, ctl, thread } = await setup();
    const id = thread.messages[0].id;
    ctl.startEdit(thread.id, id);
    ctl.drafts.set(draftKey.edit(thread.id, id), 'changed my mind');
    ctl.cancelEdit(thread.id, id);
    expect(store.get(thread.id)!.messages[0].body).toBe('Is this right?');
    expect(ctl.drafts.size).toBe(0);
    ctl.startEdit(thread.id, 'missing-message');
    expect(ctl.editing.size).toBe(0);
  });

  it('detects a stale edit, keeps the draft, and saves on the deliberate second attempt', async () => {
    const { fs, clock, store, ctl, thread } = await setup();
    const id = thread.messages[0].id;
    ctl.startEdit(thread.id, id);

    // Another device edits the same message; the vault event reloads it.
    await fs.write(threadPath(thread.id), JSON.stringify(editMessage(thread, id, 'Edited elsewhere', clock)));
    await store.reloadThreadFile(threadPath(thread.id));

    expect(await ctl.saveEdit(thread.id, id, 'My edit')).toEqual({ ok: false, message: CONFLICT_MESSAGE });
    expect(ctl.editing.has(draftKey.edit(thread.id, id))).toBe(true);
    expect(store.get(thread.id)!.messages[0].body).toBe('Edited elsewhere');

    expect(await ctl.saveEdit(thread.id, id, 'My edit')).toEqual({ ok: true });
    const message = store.get(thread.id)!.messages[0];
    expect(message.body).toBe('My edit');
    expect(message.revisions.map((r) => r.body)).toEqual(['Is this right?', 'Edited elsewhere']);
  });

  it('surfaces a conflict when the file changed without an event', async () => {
    const { fs, clock, ctl, thread } = await setup();
    await fs.write(threadPath(thread.id), JSON.stringify(addReply(thread, human, 'unseen', clock)));
    expect(await ctl.reply(thread.id, 'mine')).toEqual({ ok: false, message: CONFLICT_MESSAGE });
    // The cache adopted the disk version, so the retry appends to it instead of overwriting.
    expect(await ctl.reply(thread.id, 'mine')).toEqual({ ok: true });
  });

  it('reattaches by replacing only the anchor', async () => {
    const { fs, store, ctl, thread } = await setup();
    const tracked = fs.files.get(threadPath(thread.id));
    expect(await ctl.reattach(thread.id, note, doc, ...range('More text'))).toEqual({ ok: true });
    expect(store.anchorFor(thread.id)?.quote).toBe('More text');
    expect(fs.files.get(threadPath(thread.id))).toBe(tracked);
    expect((await ctl.reattach(thread.id, 'Other.md', doc, 0, 4)).ok).toBe(false);
    expect((await ctl.reattach('gone-thread', note, doc, 0, 4)).ok).toBe(false);
    expect((await ctl.reattach(thread.id, note, doc, 3, 3)).ok).toBe(false);
  });

  it('reports operations on missing threads and messages', async () => {
    const { ctl, thread } = await setup();
    expect((await ctl.reply('gone-thread', 'x')).ok).toBe(false);
    expect((await ctl.saveEdit(thread.id, 'missing-message', 'x')).ok).toBe(false);
    expect((await ctl.reply(thread.id, '  ')).ok).toBe(false);
  });

  it('propagates unexpected storage failures', async () => {
    const { store, ctl, thread } = await setup();
    store.save = () => Promise.reject(new Error('disk full'));
    await expect(ctl.reply(thread.id, 'x')).rejects.toThrow('disk full');
  });
});
