#!/usr/bin/env node
/**
 * Makes the sandbox feel like your real vault: copies its plugins and their
 * settings, core plugins, hotkeys, CSS snippets, templates and today's daily
 * note. The real vault is only ever READ; every write is checked to land inside
 * the sandbox. Nothing copied here is committed: the sandbox lives outside this
 * repository.
 *
 *   THREADGLYPH_SOURCE_VAULT=<your vault> npm run sandbox:pull [-- <sandbox-path>] [--refresh-daily]
 *
 * Sandbox-only safety changes to the copies:
 * - Obsidian Sync and Publish stay off, so the sandbox never joins a real remote vault.
 * - Inline Comments does not auto-dispatch agents on @mention, and its Gemini agent
 *   loses cloud consent, so daily-note text is never sent anywhere on its own.
 * - Threadglyph's sandbox shortcuts win any key conflict.
 */
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_VAULT, TEST_DATA, dailyNoteName, inside, sandboxPath, writeInside } from './sandbox-lib.mjs';

if (!SOURCE_VAULT) {
  console.error('Set THREADGLYPH_SOURCE_VAULT to the vault to copy settings from (it is only read).');
  process.exit(1);
}
const args = process.argv.slice(2);
const vault = sandboxPath(args.find((a) => !a.startsWith('--')));
const refreshDaily = args.includes('--refresh-daily');
const prod = SOURCE_VAULT;
const prodConfig = join(prod, '.obsidian');
if (!existsSync(prodConfig)) {
  console.error(`No Obsidian config found at ${prodConfig}.`);
  process.exit(1);
}
if (!existsSync(join(vault, '.obsidian', 'plugins', 'threadglyph'))) {
  console.error('Run `npm run sandbox` first, so the sandbox exists with Threadglyph linked.');
  process.exit(1);
}

const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const writeJson = (rel, value) => writeInside(vault, rel, `${JSON.stringify(value, null, 2)}\n`);
/** Copies a file or folder from the real vault into the sandbox (the source is only read). */
const copy = (fromRel, toRel = fromRel) => {
  const source = join(prod, fromRel);
  if (!existsSync(source)) return false;
  cpSync(source, inside(vault, toRel), { recursive: true, force: true, dereference: true });
  return true;
};
const report = [];

// ── Plugins and their settings ────────────────────────────────────────────────
const plugins = readdirSync(join(prodConfig, 'plugins')).filter(
  (name) => name !== 'threadglyph' && statSync(join(prodConfig, 'plugins', name)).isDirectory(),
);
for (const name of plugins) copy(`.obsidian/plugins/${name}`);
report.push(`${plugins.length} plugins copied (${plugins.join(', ')})`);

const inlineComments = inside(vault, '.obsidian/plugins/inline-comments/data.json');
if (existsSync(inlineComments)) {
  const data = readJson(inlineComments, {});
  data.autoDispatchOnMention = false;
  data.aiAgents = (data.aiAgents ?? []).map((agent) => ({ ...agent, ...(agent.cloudConsent ? { cloudConsent: false } : {}) }));
  writeJson('.obsidian/plugins/inline-comments/data.json', data);
  report.push('Inline Comments: auto-dispatch on @mention off, Gemini cloud consent off (sandbox only)');
}

const enabled = readJson(join(prodConfig, 'community-plugins.json'), []);
writeJson('.obsidian/community-plugins.json', [...new Set([...enabled, 'threadglyph'])]);
report.push(`${enabled.length} plugins enabled as in production, plus Threadglyph`);

// ── Core plugins and app settings ─────────────────────────────────────────────
const core = readJson(join(prodConfig, 'core-plugins.json'), {});
writeJson('.obsidian/core-plugins.json', { ...core, sync: false, publish: false });
report.push('Core plugins as in production, with Sync and Publish off');

const app = readJson(join(prodConfig, 'app.json'), {});
writeJson('.obsidian/app.json', {
  ...app,
  // New notes and attachments land in the sandbox's test-data area, not at the top level.
  newFileLocation: 'folder',
  newFileFolderPath: `${TEST_DATA}/Inbox`,
  attachmentFolderPath: `${TEST_DATA}/Attachments`,
});
for (const file of ['appearance.json', 'types.json', 'templates.json']) copy(`.obsidian/${file}`);
if (copy('.obsidian/snippets')) report.push('CSS snippets and appearance copied');

// Daily notes open in the test-data folder, with the real template.
const daily = readJson(join(prodConfig, 'daily-notes.json'), {});
writeJson('.obsidian/daily-notes.json', { ...daily, folder: `${TEST_DATA}/Daily notes` });

// Templater and core Templates read the same folder as production.
const templatesFolder = readJson(join(prodConfig, 'templates.json'), {}).folder;
if (templatesFolder && copy(templatesFolder)) report.push(`Templates copied (${templatesFolder}/)`);

// ── Hotkeys: production's, with Threadglyph's sandbox keys winning conflicts ──
const keyOf = (b) => `${[...b.modifiers].sort().join('+')}+${b.key.toLowerCase()}`;
const current = readJson(inside(vault, '.obsidian/hotkeys.json'), {});
const ours = Object.fromEntries(Object.entries(current).filter(([command]) => command.startsWith('threadglyph:')));
const taken = new Set(Object.values(ours).flat().map(keyOf));
const merged = {};
const displaced = [];
for (const [command, bindings] of Object.entries(readJson(join(prodConfig, 'hotkeys.json'), {}))) {
  const kept = bindings.filter((b) => !taken.has(keyOf(b)));
  if (kept.length < bindings.length) displaced.push(command);
  merged[command] = kept;
}
writeJson('.obsidian/hotkeys.json', { ...merged, ...ours });
report.push(`${Object.keys(merged).length} production hotkeys copied` +
  (displaced.length ? `; Threadglyph keeps its keys over ${displaced.join(', ')}` : ''));

// ── Today's daily note, as test data ──────────────────────────────────────────
const stamp = dailyNoteName(daily.format, new Date());
const dailyFolder = (daily.folder ?? '').replace(/^\/+/, '');
const dailyTarget = stamp && `${TEST_DATA}/Daily notes/${stamp}.md`;
if (!stamp) {
  report.push(`Daily-note format "${daily.format}" is not supported here; no daily note copied`);
} else if (existsSync(inside(vault, dailyTarget)) && !refreshDaily) {
  report.push(`Kept the sandbox copy of ${stamp}.md (use --refresh-daily to copy it again)`);
} else if (copy(join(dailyFolder, `${stamp}.md`), dailyTarget)) {
  report.push(`Today's daily note copied to ${dailyTarget}`);
} else {
  report.push(`No daily note for ${stamp} in production`);
}

console.log(`Sandbox updated from the real vault (read only):\n- ${report.join('\n- ')}`);
console.log('Quit and reopen the sandbox vault in Obsidian so the new plugins and hotkeys load.');
