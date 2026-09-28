#!/usr/bin/env node
/**
 * Creates (or refreshes) a disposable Obsidian vault for manual testing and
 * links this plugin's build output into it. Contains synthetic notes only.
 *
 *   npm run build && npm run sandbox [-- <vault-path>]
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vault = resolve(process.argv[2] ?? join(homedir(), 'Developer', 'threadglyph-sandbox-vault'));

if (vault.includes("Jonah's Space")) {
  console.error('Refusing to touch the live vault. Point this script at a disposable folder.');
  process.exit(1);
}

const notes = {
  'Welcome.md': `# Welcome to the Threadglyph sandbox

Select any sentence in this note and run **Threadglyph: Comment on selection**.

The same phrase appears twice: repeat me. And again: repeat me.

- A list item worth discussing.
- Another item with **formatting** inside.
`,
  'Long note.md': Array.from({ length: 400 }, (_, i) => `Paragraph ${i + 1}: synthetic filler text for scrolling tests.`).join('\n\n'),
  'Folder/Nested note.md': '# Nested\n\nRename this folder to check that threads follow.\n',
  'Unicode ü 🌿.md': '# Ünïcödé\n\nEmoji 🌿 and accents é à ü in an anchor.\n',
};

for (const [name, body] of Object.entries(notes)) {
  const path = join(vault, name);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, body);
}

const pluginDir = join(vault, '.obsidian', 'plugins', 'threadglyph');
mkdirSync(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const target = join(pluginDir, file);
  if (existsSync(target) || isLink(target)) rmSync(target);
  symlinkSync(join(repo, file), target);
}

const communityPlugins = join(vault, '.obsidian', 'community-plugins.json');
if (!existsSync(communityPlugins)) writeFileSync(communityPlugins, JSON.stringify(['threadglyph'], null, 2));

console.log(`Sandbox vault ready at ${vault}`);
console.log('Open it in Obsidian (Open another vault → Open folder as vault), then enable community plugins.');

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
