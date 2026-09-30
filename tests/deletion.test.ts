import { describe, expect, it } from 'vitest';
import { createThread, addReply, setMessageDeleted } from '../src/model/thread';
import { buildAiRequest } from '../src/ai/request';
import { parseThread } from '../src/storage/schema';
import { ThreadController } from '../src/controller';
import { ThreadStore } from '../src/storage/threadStore';
import { MemoryFs, fakeClock, human } from './helpers';

describe('recoverable comment deletion', () => {
  it('round trips deleted content, omits it from AI, and restores the same identity', () => {
    const clock = fakeClock();
    let thread = createThread('test.md', human, 'First', clock);
    thread = addReply(thread, human, 'Second', clock);
    const id = thread.messages[0].id;
    const deleted = setMessageDeleted(thread, id, true, clock);
    const parsed = parseThread(JSON.stringify(deleted));
    expect(parsed.ok).toBe(true);
    const request = buildAiRequest({ noteName: 'test', doc: 'test', thread: deleted, quote: 'test', anchorOffset: 0, imagePath: null }, 'anchor', null);
    expect(request.messages.map((m) => m.body)).toEqual(['Second']);
    expect(setMessageDeleted(deleted, id, true, clock)).toBe(deleted);
    const restored = setMessageDeleted(deleted, id, false, clock);
    expect(restored.messages[0]).toEqual(thread.messages[0]);
    expect(() => setMessageDeleted(thread, 'missing', true, clock)).toThrow();
    expect(parseThread(JSON.stringify({ ...thread, messages: [{ ...thread.messages[0], deletedAt: 123 }] })).ok).toBe(false);
  });

  it('preserves other replies when deletion and a reply happen together', async () => {
    const store = new ThreadStore(new MemoryFs());
    const ctl = new ThreadController(store, () => human, fakeClock());
    ctl.beginThread('test.md', 'test', 0, 4);
    const created = await ctl.commitThread('First');
    const thread = created.thread!;
    await Promise.all([ctl.setMessageDeleted(thread.id, thread.messages[0].id, true), ctl.reply(thread.id, 'Second')]);
    expect(store.get(thread.id)!.messages.map((m) => [m.body, !!m.deletedAt])).toEqual([['First', true], ['Second', false]]);
  });
});
