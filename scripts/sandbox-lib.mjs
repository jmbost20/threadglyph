/**
 * Shared helpers for the sandbox scripts. Every write goes through `inside`,
 * which refuses any path outside the sandbox vault, so a real vault can only
 * ever be read.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The vault `npm run sandbox:pull` copies settings from. There is no default:
 * set THREADGLYPH_SOURCE_VAULT to your own vault's folder to use it.
 */
export const SOURCE_VAULT = process.env.THREADGLYPH_SOURCE_VAULT
  ? resolve(expandHome(process.env.THREADGLYPH_SOURCE_VAULT))
  : null;
export const DEFAULT_SANDBOX = join(homedir(), 'Developer', 'threadglyph-sandbox-vault');
/** Where the sandbox keeps its test notes, so they are easy to find. */
export const TEST_DATA = 'Test data';
export const SAMPLES = `${TEST_DATA}/Threadglyph samples`;
/** Written into every sandbox, so a sandbox can be told apart from a real vault. */
export const SANDBOX_MARKER = '.threadglyph-sandbox';

export function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/** Where Obsidian keeps its vault list (obsidian.json) on this platform, including Linux Flatpak and Snap installs. */
export function obsidianConfigDirs() {
  if (process.platform === 'darwin') return [join(homedir(), 'Library', 'Application Support', 'obsidian')];
  if (process.platform === 'win32') return [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'obsidian')];
  return [
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'obsidian'),
    join(homedir(), '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian'),
    join(homedir(), 'snap', 'obsidian', 'current', '.config', 'obsidian'),
  ];
}

/** Vault folders Obsidian knows about on this computer (its own vault list). */
export function registeredVaults(configDirs = obsidianConfigDirs()) {
  const found = [];
  let readAny = false;
  for (const dir of configDirs) {
    try {
      const { vaults } = JSON.parse(readFileSync(join(dir, 'obsidian.json'), 'utf8'));
      readAny = true;
      for (const v of Object.values(vaults ?? {})) if (typeof v?.path === 'string') found.push(resolve(v.path));
    } catch {
      // Not installed here, or unreadable; the other checks still apply.
    }
  }
  if (!readAny) console.warn("Could not read Obsidian's vault list, so registered vaults can't be checked. Folders that already hold a vault are still refused.");
  return found;
}

/** True for a folder these scripts set up before: the marker, or the sample notes of older sandboxes (in Test data/ or at the top level). */
export function isSandbox(vault) {
  return (
    existsSync(join(vault, SANDBOX_MARKER)) ||
    existsSync(join(vault, SAMPLES, 'Welcome.md')) ||
    (existsSync(join(vault, 'Welcome.md')) && existsSync(join(vault, 'Sandbox sky.png')))
  );
}

const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** `path` with symlinks resolved through its nearest existing ancestor (the rest may not exist yet). */
export function realPath(path, depth = 0) {
  // lstat, not existsSync: a link whose target is missing still exists, and must be followed.
  const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };
  const rest = [];
  let at = resolve(path);
  while (!present(at)) {
    const parent = dirname(at);
    if (parent === at) break;
    rest.unshift(basename(at));
    at = parent;
  }
  if (!present(at)) return join(at, ...rest);
  let real;
  try {
    real = realpathSync(at);
  } catch {
    // A dangling link: resolve its target by hand, so where a write would land is checked.
    if (depth > 40) throw new Error(`Too many symbolic links: ${path}`);
    real = realPath(resolve(realPath(dirname(at), depth + 1), readlinkSync(at)), depth + 1);
  }
  return join(real, ...rest);
}

/** The nearest folder above `path` that holds an Obsidian vault, if any. */
function vaultAbove(path) {
  for (let at = dirname(path); ; at = dirname(at)) {
    if (existsSync(join(at, '.obsidian'))) return at;
    if (dirname(at) === at) return null;
  }
}

/**
 * Resolves the sandbox path. Refuses the source vault, any folder that already holds
 * an Obsidian vault and is not a sandbox, and any vault Obsidian has registered that
 * is not a sandbox (or a folder inside or around one), so a real vault can only ever
 * be read.
 */
export function sandboxPath(arg, protectedVaults = [...registeredVaults(), ...(SOURCE_VAULT ? [SOURCE_VAULT] : [])]) {
  const vault = resolve(expandHome(arg ?? DEFAULT_SANDBOX));
  // Symlinks are followed, so a link cannot smuggle the sandbox into a real vault.
  const real = realPath(vault);
  const sandbox = isSandbox(real);
  // Any existing vault that is not a sandbox is refused, even if Obsidian's list could not be read,
  // and so is any folder inside one.
  if (!sandbox && existsSync(join(real, '.obsidian'))) {
    console.error(`Refusing to use ${vault}: it is already an Obsidian vault. Point this script at a disposable folder.`);
    process.exit(1);
  }
  const above = vaultAbove(real);
  if (above) {
    console.error(`Refusing to use ${vault}: it is inside the Obsidian vault ${above}. Point this script at a disposable folder.`);
    process.exit(1);
  }
  const source = SOURCE_VAULT && realPath(SOURCE_VAULT);
  const clash = protectedVaults.map(realPath).find((p) => (p === real ? !sandbox || p === source : overlaps(p, real)));
  if (clash) {
    console.error(`Refusing to use ${vault}: it is, or overlaps, a real vault (${clash}). Point this script at a disposable folder.`);
    process.exit(1);
  }
  return vault;
}

/** `vault/rel`, refusing a path that escapes the sandbox. */
export function inside(vault, rel) {
  const path = resolve(vault, rel);
  const within = (p, root) => p === root || p.startsWith(root + sep);
  // Checked as written and with symlinks resolved, so a linked folder cannot lead out.
  if (!within(path, vault) || !within(realPath(path), realPath(vault))) {
    throw new Error(`Refusing to write outside the sandbox: ${path}`);
  }
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
  repoint(vault, from, to);
  return true;
}

/**
 * Retires a note that was replaced by another: like `moveNote`, but when the
 * replacement already exists, the old note's threads and anchors move onto it
 * and the old file is deleted, so the sandbox never keeps both.
 */
export function retireNote(vault, from, to) {
  if (moveNote(vault, from, to)) return true;
  const source = inside(vault, from);
  if (!existsSync(source) || !existsSync(inside(vault, to))) return false;
  repoint(vault, from, to);
  rmSync(source);
  return true;
}

function repoint(vault, from, to) {
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
}

export const rel = (vault, path) => relative(vault, path);

/**
 * A daily note's file name (without .md) for `date` in Obsidian's daily-note
 * `format`, which may hold folders ("YYYY/MM/YYYY-MM-DD"). Handles the common
 * tokens; any other letters outside [brackets] return null, so nothing guesses.
 */
export function dailyNoteName(format, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const tokens = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
  };
  let unsupported = false;
  const name = (format || 'YYYY-MM-DD').replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|[A-Za-z]+/g, (token, literal) => {
    if (literal !== undefined) return literal;
    if (token in tokens) return tokens[token];
    unsupported = true;
    return token;
  });
  return unsupported ? null : name;
}
