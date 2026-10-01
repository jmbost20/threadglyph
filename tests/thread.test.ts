import { describe, expect, it } from 'vitest';
import { addReply, createThread, editMessage, moveThread, setMessageDeleted, setStatus, setThreadDeleted, ThreadError } from '../src/model/thread';
import { ai, fakeClock, human } from './helpers';

describe('thread model', () => {
  it('creates a thread with one message and revision 1', () => {
    const t = createThread('Notes/a.md', human, '  First thought  ', fakeClock());
    expect(t.revision).toBe(1);
    expect(t.status).toBe('open');
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ body: 'First thought', origin: 'human', author: human });
  });

  it('rejects empty messages', () => {
    expect(() => createThread('a.md', human, '   ', fakeClock())).toThrow(ThreadError);
  });

  it('edits keep id, author and createdAt, and retain the prior body', () => {
    const clock = fakeClock();
    const t = addReply(createThread('a.md', human, 'one', clock), human, 'two', clock);
    const [first, reply] = t.messages;

    const edited = editMessage(editMessage(t, first.id, 'one, revised', clock), reply.id, 'two, revised', clock);

    expect(edited.id).toBe(t.id);
    expect(edited.messages.map((m) => m.id)).toEqual([first.id, reply.id]);
    expect(edited.messages[0]).toMatchObject({
      author: human,
      createdAt: first.createdAt,
      body: 'one, revised',
      revisions: [{ body: 'one' }],
    });
    expect(edited.messages[0].editedAt).toBeDefined();
    expect(edited.messages[1].revisions).toEqual([{ body: 'two', replacedAt: edited.messages[1].editedAt }]);
    expect(edited.revision).toBe(t.revision + 2);
  });

  it('an unchanged edit (cancel-equivalent) is a no-op', () => {
    const t = createThread('a.md', human, 'same', fakeClock());
    expect(editMessage(t, t.messages[0].id, 'same')).toBe(t);
  });

  it('editing AI output marks it ai-edited instead of a raw model reply', () => {
    const clock = fakeClock();
    const t = addReply(createThread('a.md', human, 'q', clock), ai, 'draft answer', clock);
    expect(t.messages[1].origin).toBe('ai');
    const edited = editMessage(t, t.messages[1].id, 'my version', clock);
    expect(edited.messages[1].origin).toBe('ai-edited');
    expect(edited.messages[1].author).toEqual(ai);
  });

  it('rejects edits to unknown messages', () => {
    const t = createThread('a.md', human, 'x', fakeClock());
    expect(() => editMessage(t, 'nope', 'y')).toThrow(ThreadError);
  });

  it('resolve/reopen and move bump the revision only on change', () => {
    const clock = fakeClock();
    const t = createThread('a.md', human, 'x', clock);
    const resolved = setStatus(t, 'resolved', clock);
    expect(resolved.status).toBe('resolved');
    expect(resolved.messages).toEqual(t.messages);
    expect(setStatus(resolved, 'resolved', clock)).toBe(resolved);
    expect(setStatus(resolved, 'open', clock).revision).toBe(3);
    expect(moveThread(t, 'a.md', clock)).toBe(t);
    expect(moveThread(t, 'b.md', clock).notePath).toBe('b.md');
  });
});

describe('deleting a whole thread', () => {
  it('deletes every comment at once, and restores only those, not one deleted earlier', () => {
    const clock = fakeClock();
    let t = addReply(addReply(createThread('n.md', human, 'a', clock), human, 'b', clock), human, 'c', clock);
    t = setMessageDeleted(t, t.messages[1].id, true, clock);
    const gone = setThreadDeleted(t, true, clock);
    expect(gone.messages.every((m) => m.deletedAt)).toBe(true);
    expect(setThreadDeleted(gone, true, clock)).toBe(gone);
    const back = setThreadDeleted(gone, false, clock);
    expect(back.messages.map((m) => !!m.deletedAt)).toEqual([false, true, false]);
    expect(setThreadDeleted(back, false, clock)).toBe(back);
  });
});

