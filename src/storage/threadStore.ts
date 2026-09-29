import { moveThread, type Clock, systemClock } from '../model/thread';
import type { TextAnchor, ThreadRecord } from '../model/types';
import { ANCHORS_DIR, THREADS_DIR, anchorPath, idFromPath, threadPath } from './paths';
import { parseAnchor, parseThread, serialize } from './schema';

/** Minimal file access, implemented over Obsidian's DataAdapter in the plugin and in memory in tests. */
export interface FileStore {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  /** Paths of files directly inside `dir`; empty when the folder does not exist. */
  list(dir: string): Promise<string[]>;
  ensureDir(dir: string): Promise<void>;
}

export type SaveResult =
  | { ok: true; thread: ThreadRecord }
  /** The record on disk moved on (or vanished) since the caller loaded it. Nothing was written. */
  | { ok: false; reason: 'conflict'; current: ThreadRecord | null };

export type UpdateResult = SaveResult | { ok: false; reason: 'missing'; current: null };

/** Where `path` ends up when `oldPath` (a note or folder) is renamed, or null if it is unaffected. */
function renamedPath(path: string, oldPath: string, newPath: string): string | null {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return null;
}

export interface LoadProblem {
  path: string;
  error: string;
}

export class ThreadStore {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly anchors = new Map<string, TextAnchor>();
  private readonly problems = new Map<string, string>();
  /** Tail of the pending write chain for each thread; writes to one thread never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fs: FileStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Reads every record once. Called at startup, never per keystroke. */
  async loadAll(): Promise<void> {
    this.threads.clear();
    this.anchors.clear();
    this.problems.clear();
    for (const path of await this.fs.list(THREADS_DIR)) await this.reloadThreadFile(path);
    for (const path of await this.fs.list(ANCHORS_DIR)) await this.reloadAnchorFile(path);
  }

  /** Re-reads one record after an external change. Malformed files are reported, never rewritten. */
  async reloadThreadFile(path: string): Promise<ThreadRecord | null> {
    const id = idFromPath(THREADS_DIR, path);
    if (!id) return null;
    const raw = await this.fs.read(path);
    this.problems.delete(path);
    if (raw === null) {
      this.threads.delete(id);
      return null;
    }
    const parsed = parseThread(raw);
    if (!parsed.ok || parsed.value.id !== id) {
      this.threads.delete(id);
      this.problems.set(path, parsed.ok ? 'file name does not match its id' : parsed.error);
      return null;
    }
    this.threads.set(id, parsed.value);
    return parsed.value;
  }

  async reloadAnchorFile(path: string): Promise<TextAnchor | null> {
    const id = idFromPath(ANCHORS_DIR, path);
    if (!id) return null;
    const raw = await this.fs.read(path);
    const parsed = raw === null ? null : parseAnchor(raw);
    if (!parsed?.ok || parsed.value.threadId !== id) {
      this.anchors.delete(id);
      if (parsed && !parsed.ok) this.problems.set(path, parsed.error);
      return null;
    }
    this.anchors.set(id, parsed.value);
    return parsed.value;
  }

  get(id: string): ThreadRecord | undefined {
    return this.threads.get(id);
  }

  anchorFor(id: string): TextAnchor | undefined {
    return this.anchors.get(id);
  }

  forNote(notePath: string): ThreadRecord[] {
    return [...this.threads.values()]
      .filter((t) => t.notePath === notePath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Every loaded thread and anchor, for a backup. */
  snapshot(): { threads: ThreadRecord[]; anchors: TextAnchor[] } {
    return { threads: [...this.threads.values()], anchors: [...this.anchors.values()] };
  }

  /**
   * Adds a thread from a backup unless a thread with its id already exists
   * (in memory or on disk). Existing data is never overwritten.
   */
  async restore(thread: ThreadRecord, anchor: TextAnchor | undefined): Promise<'restored' | 'exists'> {
    if (this.threads.has(thread.id) || (await this.fs.read(threadPath(thread.id))) !== null) return 'exists';
    if (anchor) await this.writeAnchor(anchor);
    await this.fs.ensureDir(THREADS_DIR);
    await this.fs.write(threadPath(thread.id), serialize(thread));
    this.threads.set(thread.id, thread);
    return 'restored';
  }

  hasThreads(notePath: string): boolean {
    for (const t of this.threads.values()) if (t.notePath === notePath) return true;
    return false;
  }

  loadProblems(): LoadProblem[] {
    return [...this.problems].map(([path, error]) => ({ path, error }));
  }

  async create(thread: ThreadRecord, anchor: TextAnchor): Promise<void> {
    if (anchor.threadId !== thread.id) throw new Error('Anchor does not belong to this thread.');
    const path = threadPath(thread.id);
    if ((await this.fs.read(path)) !== null) throw new Error(`Thread ${thread.id} already exists.`);
    await this.writeAnchor(anchor);
    await this.fs.ensureDir(THREADS_DIR);
    await this.fs.write(path, serialize(thread));
    this.threads.set(thread.id, thread);
  }

  /**
   * Writes `next` only if the file on disk is still at `expectedRevision`.
   * On a mismatch nothing is written; the cache takes the on-disk version and
   * the caller keeps its draft so the user can re-apply it. Saves to the same
   * thread run one at a time, so two saves from one revision cannot both pass.
   */
  save(next: ThreadRecord, expectedRevision: number): Promise<SaveResult> {
    return this.serialized(next.id, () => this.saveNow(next, expectedRevision));
  }

  /**
   * Applies `change` to the latest cached version, in turn with any other
   * write to the same thread. Use this for in-app edits: rapid actions build
   * on each other instead of racing from the same snapshot.
   */
  update(id: string, change: (thread: ThreadRecord) => ThreadRecord): Promise<UpdateResult> {
    return this.serialized(id, async (): Promise<UpdateResult> => {
      const thread = this.threads.get(id);
      if (!thread) return { ok: false, reason: 'missing', current: null };
      const next = change(thread);
      if (next === thread) return { ok: true, thread };
      return this.saveNow(next, thread.revision);
    });
  }

  private serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.queues.set(id, run);
    const release = () => {
      if (this.queues.get(id) === run) this.queues.delete(id);
    };
    run.then(release, release);
    return run;
  }

  private async saveNow(next: ThreadRecord, expectedRevision: number): Promise<SaveResult> {
    const path = threadPath(next.id);
    const raw = await this.fs.read(path);
    const onDisk = raw === null ? null : parseThread(raw);
    const current = onDisk?.ok ? onDisk.value : null;
    if (current?.revision !== expectedRevision) {
      if (current) this.threads.set(current.id, current);
      else if (raw === null) this.threads.delete(next.id);
      return { ok: false, reason: 'conflict', current };
    }
    await this.fs.write(path, serialize(next));
    this.threads.set(next.id, next);
    return { ok: true, thread: next };
  }

  /** Replaces a thread's anchor (reattach). The message history is untouched. */
  async writeAnchor(anchor: TextAnchor): Promise<void> {
    await this.fs.ensureDir(ANCHORS_DIR);
    await this.fs.write(anchorPath(anchor.threadId), serialize(anchor));
    this.anchors.set(anchor.threadId, anchor);
  }

  /** Follows a note (or folder) rename. Returns threads that could not be moved because of a conflict. */
  async renameNote(oldPath: string, newPath: string): Promise<string[]> {
    // Decide every move before the first await: the cache can change while writes are in flight.
    const moves: { id: string; target: string }[] = [];
    for (const thread of this.threads.values()) {
      const target = renamedPath(thread.notePath, oldPath, newPath);
      if (target !== null) moves.push({ id: thread.id, target });
    }
    const conflicts: string[] = [];
    for (const { id, target } of moves) {
      const result = await this.update(id, (latest) => moveThread(latest, target, this.clock));
      if (!result.ok) conflicts.push(id);
      const anchor = this.anchors.get(id);
      if (anchor) await this.writeAnchor({ ...anchor, notePath: target });
    }
    // Image threads follow their image file (or a renamed folder containing it).
    const imageMoves: TextAnchor[] = [];
    for (const anchor of this.anchors.values()) {
      const image = anchor.imagePath === undefined ? null : renamedPath(anchor.imagePath, oldPath, newPath);
      if (image !== null) imageMoves.push({ ...anchor, imagePath: image });
    }
    for (const anchor of imageMoves) await this.writeAnchor(anchor);
    return conflicts;
  }
}
