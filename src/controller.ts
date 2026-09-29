import { imageSupport } from './anchor/imageEmbed';
import { captureTextAnchor } from './anchor/textAnchor';
import { addReply, createThread, editMessage, setStatus, type Clock, systemClock, ThreadError } from './model/thread';
import type { Author, TextAnchor, ThreadRecord } from './model/types';
import type { ThreadStore } from './storage/threadStore';
import { draftKey } from './ui/viewModel';

/** A selection waiting for its first comment. Its anchor id is replaced by the new thread's id. */
export interface PendingThread {
  notePath: string;
  anchor: TextAnchor;
}

export type Outcome = { ok: true } | { ok: false; message: string };

const PENDING_ID = 'pending-thread';
const OK: Outcome = { ok: true };

export const CONFLICT_MESSAGE =
  'This thread changed elsewhere (sync or another window). Your text is kept; review the latest version and save again.';

/**
 * UI-independent thread operations. Owns drafts and edit sessions so unsaved
 * text survives re-rendering, and routes every write through the store's
 * revision check.
 */
export class ThreadController {
  readonly drafts = new Map<string, string>();
  readonly editing = new Set<string>();
  /** Body of each message when its edit began; a different body at save time means the edit is stale. */
  private readonly editBase = new Map<string, string>();
  pending: PendingThread | null = null;

  constructor(
    private readonly store: ThreadStore,
    private readonly author: () => Author,
    private readonly clock: Clock = systemClock,
  ) {}

  beginThread(notePath: string, doc: string, from: number, to: number): Outcome {
    try {
      this.pending = { notePath, anchor: captureTextAnchor(PENDING_ID, notePath, doc, from, to) };
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * Starts a thread on an image embed at `from`–`to` (the embed markup) whose
   * file is `imagePath`. Unsupported formats are refused here, before any typing.
   */
  beginImageThread(notePath: string, doc: string, from: number, to: number, imagePath: string): Outcome {
    const support = imageSupport(imagePath);
    if (!support.ok) return { ok: false, message: support.reason };
    const outcome = this.beginThread(notePath, doc, from, to);
    if (outcome.ok && this.pending) this.pending.anchor = { ...this.pending.anchor, kind: 'image', imagePath };
    return outcome;
  }

  cancelThread(): void {
    if (this.pending) this.drafts.delete(draftKey.newThread(this.pending.notePath));
    this.pending = null;
  }

  async commitThread(body: string): Promise<Outcome & { thread?: ThreadRecord }> {
    const pending = this.pending;
    if (!pending) return { ok: false, message: 'There is no selection waiting for a comment.' };
    // Claim the selection before the first await so a double submit cannot create two threads.
    this.pending = null;
    let thread: ThreadRecord | undefined;
    let outcome: Outcome;
    try {
      outcome = await this.guard(async () => {
        thread = createThread(pending.notePath, this.author(), body, this.clock, pending.anchor.kind);
        await this.store.create(thread, { ...pending.anchor, threadId: thread.id });
        return OK;
      });
    } catch (err) {
      // Unexpected failures (disk errors) must not lose the selection either.
      this.pending ??= pending;
      throw err;
    }
    if (!outcome.ok) {
      this.pending ??= pending;
      return outcome;
    }
    return { ...outcome, thread };
  }

  async reply(threadId: string, body: string): Promise<Outcome> {
    return this.update(threadId, (t) => addReply(t, this.author(), body, this.clock));
  }

  startEdit(threadId: string, messageId: string): void {
    const message = this.store.get(threadId)?.messages.find((m) => m.id === messageId);
    if (!message) return;
    const key = draftKey.edit(threadId, messageId);
    this.editing.add(key);
    this.editBase.set(key, message.body);
    if (!this.drafts.has(key)) this.drafts.set(key, message.body);
  }

  cancelEdit(threadId: string, messageId: string): void {
    const key = draftKey.edit(threadId, messageId);
    this.editing.delete(key);
    this.editBase.delete(key);
    this.drafts.delete(key);
  }

  async saveEdit(threadId: string, messageId: string, body: string): Promise<Outcome> {
    const key = draftKey.edit(threadId, messageId);
    const current = this.store.get(threadId)?.messages.find((m) => m.id === messageId);
    const base = this.editBase.get(key);
    if (current && base !== undefined && current.body !== base) {
      // Someone else changed this message after the edit began. Keep the draft and
      // rebase, so a second Save is a deliberate overwrite of content the user has now seen.
      this.editBase.set(key, current.body);
      return { ok: false, message: CONFLICT_MESSAGE };
    }
    const result = await this.update(threadId, (t) => editMessage(t, messageId, body, this.clock));
    if (result.ok) {
      this.editing.delete(key);
      this.editBase.delete(key);
    }
    return result;
  }

  async setResolved(threadId: string, resolved: boolean): Promise<Outcome> {
    return this.update(threadId, (t) => setStatus(t, resolved ? 'resolved' : 'open', this.clock));
  }

  /**
   * Points a thread at a new passage, or for an image thread at an image embed
   * (`imagePath` is its file). Only the local anchor changes; messages are untouched.
   */
  async reattach(
    threadId: string,
    notePath: string,
    doc: string,
    from: number,
    to: number,
    imagePath?: string,
  ): Promise<Outcome> {
    const thread = this.store.get(threadId);
    if (!thread) return { ok: false, message: 'That thread no longer exists.' };
    if (thread.notePath !== notePath) return { ok: false, message: 'Select the new passage in the thread’s own note.' };
    const image = thread.anchorKind === 'image';
    if (image && !imagePath) return { ok: false, message: 'Put the cursor on an image embed, then reattach.' };
    if (image) {
      const support = imageSupport(imagePath!);
      if (!support.ok) return { ok: false, message: support.reason };
    }
    return this.guard(async () => {
      const anchor = captureTextAnchor(threadId, notePath, doc, from, to);
      await this.store.writeAnchor(image ? { ...anchor, kind: 'image', imagePath } : anchor);
      return { ok: true };
    });
  }

  /** Applies `change` to the latest version, queued behind any other write to the same thread. */
  private async update(threadId: string, change: (t: ThreadRecord) => ThreadRecord): Promise<Outcome> {
    return this.guard(async () => {
      const result = await this.store.update(threadId, change);
      if (result.ok) return OK;
      return { ok: false, message: result.reason === 'missing' ? 'That thread no longer exists.' : CONFLICT_MESSAGE };
    });
  }

  private async guard(work: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof ThreadError || err instanceof RangeError) return { ok: false, message: err.message };
      throw err;
    }
  }
}
