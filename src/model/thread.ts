import { SCHEMA_VERSION, type AnchorKind, type Author, type Message, type MessageOrigin, type ThreadRecord } from './types';

export interface Clock {
  now(): string;
  newId(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};

export class ThreadError extends Error {}

function requireBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new ThreadError('A message cannot be empty.');
  return trimmed;
}

function newMessage(author: Author, body: string, clock: Clock): Message {
  return {
    id: clock.newId(),
    author: { ...author },
    origin: author.kind === 'ai' ? 'ai' : 'human',
    createdAt: clock.now(),
    body: requireBody(body),
    revisions: [],
  };
}

/** Returns a copy with `updatedAt` refreshed and the revision bumped. */
function touch(thread: ThreadRecord, clock: Clock, changes: Partial<ThreadRecord>): ThreadRecord {
  return { ...thread, ...changes, updatedAt: clock.now(), revision: thread.revision + 1 };
}

export function createThread(
  notePath: string,
  author: Author,
  body: string,
  clock: Clock = systemClock,
  anchorKind: AnchorKind = 'text',
): ThreadRecord {
  const first = newMessage(author, body, clock);
  return {
    schema: SCHEMA_VERSION,
    id: clock.newId(),
    notePath,
    anchorKind,
    status: 'open',
    createdAt: first.createdAt,
    updatedAt: first.createdAt,
    revision: 1,
    messages: [first],
  };
}

export function addReply(
  thread: ThreadRecord,
  author: Author,
  body: string,
  clock: Clock = systemClock,
  /** For AI authors: `ai-edited` when the person revised the draft before adding it. */
  origin?: MessageOrigin,
): ThreadRecord {
  const reply = newMessage(author, body, clock);
  if (origin && author.kind === 'ai') reply.origin = origin;
  return touch(thread, clock, { messages: [...thread.messages, reply] });
}

/**
 * Replaces a message body while keeping its id, author and creation time.
 * The previous body is retained in `revisions`. Editing AI output marks it
 * `ai-edited` so it is no longer shown as an untouched model response.
 */
export function editMessage(
  thread: ThreadRecord,
  messageId: string,
  body: string,
  clock: Clock = systemClock,
): ThreadRecord {
  const next = requireBody(body);
  const index = thread.messages.findIndex((m) => m.id === messageId);
  if (index === -1) throw new ThreadError(`Message ${messageId} is not in this thread.`);
  const current = thread.messages[index];
  if (current.body === next) return thread;

  const at = clock.now();
  const edited: Message = {
    ...current,
    body: next,
    editedAt: at,
    origin: current.origin === 'human' ? 'human' : 'ai-edited',
    revisions: [...current.revisions, { body: current.body, replacedAt: at }],
  };
  const messages = thread.messages.slice();
  messages[index] = edited;
  return touch(thread, clock, { messages });
}

export function setStatus(
  thread: ThreadRecord,
  status: ThreadRecord['status'],
  clock: Clock = systemClock,
): ThreadRecord {
  if (thread.status === status) return thread;
  return touch(thread, clock, { status });
}

export function moveThread(
  thread: ThreadRecord,
  notePath: string,
  clock: Clock = systemClock,
): ThreadRecord {
  if (thread.notePath === notePath) return thread;
  return touch(thread, clock, { notePath });
}

/** Reversible deletion; never discard the original text or revisions. */
export function setMessageDeleted(thread: ThreadRecord, messageId: string, deleted: boolean, clock: Clock = systemClock): ThreadRecord {
  const message = thread.messages.find((m) => m.id === messageId);
  if (!message) throw new ThreadError('That comment no longer exists.');
  if (!!message.deletedAt === deleted) return thread;
  const next = { ...message };
  if (deleted) next.deletedAt = clock.now();
  else delete next.deletedAt;
  return touch(thread, clock, { messages: thread.messages.map((m) => m.id === messageId ? next : m) });
}
