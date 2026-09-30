/**
 * Shared helpers for the sandbox scripts. Every write goes through `inside`,
 * which refuses any path outside the sandbox vault, so the owner's real vault
 * can only ever be read.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const PRODUCTION_VAULT = join(homedir(), 'Documents', "Jonah's Space");
export const DEFAULT_SANDBOX = join(homedir(), 'Developer', 'threadglyph-sandbox-vault');
/** Where the sandbox keeps its test notes, so they are easy to find. */
export const TEST_DATA = 'Test data';
export const SAMPLES = `${TEST_DATA}/Threadglyph samples`;

/** Resolves the sandbox path and refuses anything that is, or is inside, the real vault. */
export function sandboxPath(arg) {
  const vault = resolve(arg ?? DEFAULT_SANDBOX);
  const prod = resolve(PRODUCTION_VAULT);
  if (vault.includes("Jonah's Space") || vault === prod || vault.startsWith(prod + sep) || prod.startsWith(vault + sep)) {
    console.error('Refusing to touch the live vault. Point this script at a disposable folder.');
    process.exit(1);
  }
  return vault;
}

/** `vault/rel`, refusing a path that escapes the sandbox. */
export function inside(vault, rel) {
  const path = resolve(vault, rel);
  if (path !== vault && !path.startsWith(vault + sep)) throw new Error(`Refusing to write outside the sandbox: ${path}`);
  return path;
}

export function writeInside(vault, rel, data) {
  const path = inside(vault, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Moves a note inside the sandbox and points its Threadglyph threads and
 * anchors at the new path, as the plugin does for a rename in Obsidian.
 */
export function moveNote(vault, from, to) {
  const source = inside(vault, from);
  const target = inside(vault, to);
  if (!existsSync(source) || existsSync(target)) return false;
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
  const now = new Date().toISOString();
  const rewrite = (dir, update) => {
    const folder = inside(vault, dir);
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder).filter((n) => n.endsWith('.json'))) {
      const path = join(folder, name);
      const record = readJson(path);
      const next = update(record);
      if (next) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    }
  };
  rewrite('threadglyph/threads', (t) => (t.notePath === from ? { ...t, notePath: to, updatedAt: now, revision: t.revision + 1 } : null));
  rewrite('.threadglyph/anchors', (a) => {
    if (a.notePath !== from && a.imagePath !== from) return null;
    return { ...a, ...(a.notePath === from ? { notePath: to } : {}), ...(a.imagePath === from ? { imagePath: to } : {}) };
  });
  return true;
}

export const rel = (vault, path) => relative(vault, path);
