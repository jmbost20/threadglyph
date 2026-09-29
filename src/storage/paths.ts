/** Vault-relative folder for tracked thread records (safe to commit). */
export const THREADS_DIR = 'threadglyph/threads';
/** Vault-relative folder for local-only anchors that contain quoted note text. */
export const ANCHORS_DIR = '.threadglyph/anchors';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(dir: string, id: string): string {
  if (!isSafeId(id)) throw new Error(`Refusing unsafe thread id: ${JSON.stringify(id)}`);
  return `${dir}/${id}.json`;
}

export const threadPath = (id: string): string => fileFor(THREADS_DIR, id);
export const anchorPath = (id: string): string => fileFor(ANCHORS_DIR, id);

/** Extracts the id from a file inside `dir`, or null if the path is not one of ours. */
export function idFromPath(dir: string, path: string): string | null {
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return null;
  const id = path.slice(prefix.length, -'.json'.length);
  return isSafeId(id) ? id : null;
}
