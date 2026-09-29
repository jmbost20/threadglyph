import { describe, expect, it } from 'vitest';
import { createThread } from '../src/model/thread';
import { ANCHORS_DIR, THREADS_DIR, anchorPath, idFromPath, isSafeId, threadPath } from '../src/storage/paths';
import { parseAnchor, parseThread, serialize } from '../src/storage/schema';
import { fakeClock, human } from './helpers';

describe('storage paths', () => {
  it.each(['../../etc/passwd', '..%2f', 'a/b', 'UPPER-CASE', 'short', '', 'x'.repeat(65), ' spaced-id-1'])(
    'rejects crafted id %j',
    (id) => {
      expect(isSafeId(id)).toBe(false);
      expect(() => threadPath(id)).toThrow(/unsafe/);
      expect(() => anchorPath(id)).toThrow(/unsafe/);
    },
  );

  it('rejects non-string ids', () => {
    expect(isSafeId(42)).toBe(false);
  });

  it('builds paths inside the owned folders', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(threadPath(id)).toBe(`${THREADS_DIR}/${id}.json`);
    expect(anchorPath(id)).toBe(`${ANCHORS_DIR}/${id}.json`);
    expect(idFromPath(THREADS_DIR, threadPath(id))).toBe(id);
    expect(idFromPath(THREADS_DIR, `${THREADS_DIR}/../x.json`)).toBeNull();
    expect(idFromPath(THREADS_DIR, 'elsewhere/abc.json')).toBeNull();
  });
});

describe('schema validation', () => {
  const valid = createThread('a.md', human, 'hello', fakeClock());

  it('round-trips a valid record', () => {
    expect(parseThread(serialize(valid))).toEqual({ ok: true, value: valid });
  });

  it.each([
    ['not json', '{'],
    ['array', '[]'],
    ['future schema', JSON.stringify({ ...valid, schema: 2 })],
    ['bad id', JSON.stringify({ ...valid, id: '../x' })],
    ['empty path', JSON.stringify({ ...valid, notePath: '' })],
    ['bad kind', JSON.stringify({ ...valid, anchorKind: 'video' })],
    ['bad status', JSON.stringify({ ...valid, status: 'agree' })],
    ['bad timestamps', JSON.stringify({ ...valid, updatedAt: 5 })],
    ['bad revision', JSON.stringify({ ...valid, revision: 0 })],
    ['no messages', JSON.stringify({ ...valid, messages: [] })],
    ['message not object', JSON.stringify({ ...valid, messages: ['x'] })],
    ['message bad id', JSON.stringify({ ...valid, messages: [{ ...valid.messages[0], id: 'no' }] })],
    ['message bad author', JSON.stringify({ ...valid, messages: [{ ...valid.messages[0], author: { kind: 'bot' } }] })],
    ['message bad origin', JSON.stringify({ ...valid, messages: [{ ...valid.messages[0], origin: 'x' }] })],
    ['message no body', JSON.stringify({ ...valid, messages: [{ ...valid.messages[0], body: null }] })],
    ['message bad editedAt', JSON.stringify({ ...valid, messages: [{ ...valid.messages[0], editedAt: 1 }] })],
    ['message bad revisions', JSON.stringify({ ...valid, messages: [{ ...valid.messages[0], revisions: [{}] }] })],
  ])('rejects %s', (_label, raw) => {
    expect(parseThread(raw).ok).toBe(false);
  });

  it('keeps hostile text as inert data', () => {
    const hostile = { ...valid, messages: [{ ...valid.messages[0], body: '<img src=x onerror=alert(1)>' }] };
    const parsed = parseThread(JSON.stringify(hostile));
    expect(parsed.ok && parsed.value.messages[0].body).toBe('<img src=x onerror=alert(1)>');
  });

  it('validates anchors', () => {
    const anchor = { schema: 1, threadId: valid.id, kind: 'text', notePath: 'a.md', quote: 'q', prefix: '', suffix: '', lineHint: 0 };
    expect(parseAnchor(JSON.stringify(anchor)).ok).toBe(true);
    expect(parseAnchor('nope').ok).toBe(false);
    expect(parseAnchor('"str"').ok).toBe(false);
    expect(parseAnchor(JSON.stringify({ ...anchor, schema: 9 })).ok).toBe(false);
    expect(parseAnchor(JSON.stringify({ ...anchor, threadId: '../' })).ok).toBe(false);
    expect(parseAnchor(JSON.stringify({ ...anchor, lineHint: 'x' })).ok).toBe(false);
  });
});
