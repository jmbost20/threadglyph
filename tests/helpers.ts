import type { Clock } from '../src/model/thread';
import type { FileStore } from '../src/storage/threadStore';

/** Deterministic clock: ids and timestamps advance on every call. */
export function fakeClock(): Clock {
  let tick = 0;
  let id = 0;
  return {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    newId: () => `id-${String(++id).padStart(8, '0')}`,
  };
}

export class MemoryFs implements FileStore {
  files = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = `${dir}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
  }

  async ensureDir(): Promise<void> {}
}

export const human = { kind: 'human' as const, name: 'Jonah' };
export const ai = { kind: 'ai' as const, name: 'Assistant' };
