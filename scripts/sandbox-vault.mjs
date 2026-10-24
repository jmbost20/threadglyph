#!/usr/bin/env node
/**
 * Creates (or refreshes) a disposable Obsidian vault for manual testing and
 * links this plugin's build output into it. Contains synthetic notes only.
 *
 *   npm run build && npm run sandbox [-- <vault-path>]
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync, rmdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { SAMPLES, SANDBOX_MARKER, expandHome, inside, moveNote, sandboxPath } from './sandbox-lib.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vault = sandboxPath(process.argv[2]);
mkdirSync(vault, { recursive: true });
const marker = join(vault, SANDBOX_MARKER);
if (!existsSync(marker)) writeFileSync(marker, 'Disposable Threadglyph test vault, made by `npm run sandbox`.\n');

const notes = {
  'Welcome.md': `# Welcome to the Threadglyph sandbox

Select any sentence in this note and run **Threadglyph: Comment on selection**.

The same phrase appears twice: repeat me. And again: repeat me.

- A list item worth discussing.
- Another item with **formatting** inside.
`,
  'Ask AI playground.md': `# Ask AI playground

Synthetic notes for trying Ask AI. Select a passage, comment "@Local what is missing here?", and post with ⌘↩. Nothing is sent until you press Send in the preview.

## Groceries
- [ ] Shopping list
  - [ ] milk
  - [ ] apples
  - [ ] bread
  - [ ] coffee

## Weekend
- [ ] Clean the garage
  - [ ] sweep the floor
  - [ ] sort the tool drawer
  - [ ] fix the shelf

## Ideas
A few ideas for the reading group:
- Short stories
`,
  'Recipes.md': `# Recipes

## Pasta
Boil water, salt it well, cook the pasta two minutes short of the packet time, finish in the sauce.

## Pancakes
Flour, milk, eggs, a pinch of salt. Rest the batter for ten minutes.
`,
  'Long note.md': Array.from({ length: 400 }, (_, i) => `Paragraph ${i + 1}: synthetic filler text for scrolling tests.`).join('\n\n'),
  'Folder/Nested note.md': '# Nested\n\nRename this folder to check that threads follow.\n',
  'Unicode ü 🌿.md': '# Ünïcödé\n\nEmoji 🌿 and accents é à ü in an anchor.\n',
  'Images.md': `# Image threads

Each image has a title line under it with a **Comment** button. You can also put the cursor on an embed and run **Threadglyph: Comment on selection**.

![[Sandbox sky.png]]

With a title in the alias: ![[Sandbox sky.png|Evening sky|200]]

The same picture twice, smaller: ![[Sandbox sky.png|120]]

A Markdown-style embed: ![a meadow](<Attachments/Sandbox meadow.png>)

Unsupported format (shows a clear message): ![[Not supported.heic]]

Missing file: ![[Nowhere.png]]
`,
  'Image titles.md': `# Image titles

Every image below shows a title line with a **Comment** button. The title comes from the alias or alt text, else the file name. Nothing is written into this note.

![[Sandbox sky.png|Evening sky]]

![[Attachments/Sandbox meadow.png|200]]

![A green meadow](<Attachments/Sandbox meadow.png>)
`,
  // Synthetic comments in the old Agent Comments format, for the import preview.
  'Agent Comments sample.md': `# Garden plan (Agent Comments sample)

Run **Threadglyph: Import Agent Comments from this note**. The note is not changed.

We should {==plant the tomatoes early==}{>>user|2026-09-16 14:20|question: Is April too soon here?<<}{>>Local|2026-09-16 14:21|reply: Frost can still hit in April; mid-May is safer.<<}{>>user|2026-09-16 14:25|react: 👍 #1<<} this year.

Also {==compost the fallen leaves==}{>>user|2026-09-17 09:00|important: Shred them first so they break down faster.<<}{>>user|2026-09-17 09:05|resolve: <<} before winter.

{==Water deeply twice a week==}{>>Gemini|2026-09-18 18:30|suggest: Water deeply once or twice a week, depending on rain.<<} rather than a little every day.
`,
};

// Samples live under Test data/ so they are easy to tell apart. Older sandboxes kept them
// at the top level; move those (with their threads) instead of writing second copies.
for (const name of [...Object.keys(notes), 'Sandbox sky.png', 'Attachments/Sandbox meadow.png', 'Not supported.heic']) {
  moveNote(vault, name, `${SAMPLES}/${name}`);
}
for (const empty of ['Folder', 'Attachments']) {
  try {
    rmdirSync(join(vault, empty));
  } catch {
    // Not there, or it holds other files.
  }
}

for (const [name, body] of Object.entries(notes)) {
  const path = join(vault, SAMPLES, name);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, body);
}

// Synthetic images: flat gradients drawn here, so no real photo ever enters the sandbox.
const images = {
  'Sandbox sky.png': [90, 140, 220],
  'Attachments/Sandbox meadow.png': [80, 170, 90],
};
for (const [name, rgb] of Object.entries(images)) {
  const path = join(vault, SAMPLES, name);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, gradientPng(240, 140, rgb));
}
const heic = join(vault, SAMPLES, 'Not supported.heic');
if (!existsSync(heic)) writeFileSync(heic, 'placeholder, not a real HEIC file');

const pluginDir = join(vault, '.obsidian', 'plugins', 'threadglyph');
mkdirSync(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const target = join(pluginDir, file);
  if (existsSync(target) || isLink(target)) rmSync(target);
  symlinkSync(join(repo, file), target);
}

// Sandbox only: Ask AI starts switched on (Local first). If THREADGLYPH_GEMINI_FOLDER names a
// Gemini folder that already holds a key (.env), the sandbox borrows it read-only so Gemini
// works without setup. An existing settings file is kept.
const pluginData = join(pluginDir, 'data.json');
if (!existsSync(pluginData)) {
  const sharedGemini = process.env.THREADGLYPH_GEMINI_FOLDER;
  const borrow = sharedGemini && existsSync(join(expandHome(sharedGemini), '.env'));
  const settings = { aiEnabled: true, ...(borrow ? { geminiFolder: sharedGemini } : {}) };
  writeFileSync(pluginData, JSON.stringify(settings, null, 2));
}

const communityPlugins = join(vault, '.obsidian', 'community-plugins.json');
if (!existsSync(communityPlugins)) writeFileSync(communityPlugins, JSON.stringify(['threadglyph'], null, 2));

// Sandbox-only shortcuts (Cmd/Ctrl+/ to comment). The plugin itself ships without
// default hotkeys so it never collides with other comment plugins.
// Existing bindings in the sandbox are kept.
const hotkeysPath = join(vault, '.obsidian', 'hotkeys.json');
const hotkeys = existsSync(hotkeysPath) ? JSON.parse(readFileSync(hotkeysPath, 'utf8')) : {};
const defaults = {
  'threadglyph:comment-on-selection': [{ modifiers: ['Mod'], key: '/' }],
  'threadglyph:reply-at-cursor': [{ modifiers: ['Mod', 'Alt'], key: '/' }],
  'threadglyph:next-thread': [{ modifiers: ['Mod', 'Alt'], key: ']' }],
  'threadglyph:previous-thread': [{ modifiers: ['Mod', 'Alt'], key: '[' }],
};
for (const [command, keys] of Object.entries(defaults)) hotkeys[command] ??= keys;
// Commands that no longer exist (the removed @agent).
for (const gone of ['threadglyph:run-agent-on-line', 'threadglyph:open-agent-chat']) delete hotkeys[gone];
// ...and its sample note, in an existing sandbox (Gitar on #25).
for (const old of ['Agent playground.md', `${SAMPLES}/Agent playground.md`]) rmSync(inside(vault, old), { force: true });
writeFileSync(hotkeysPath, JSON.stringify(hotkeys, null, 2));

console.log(`Sandbox vault ready at ${vault}`);
console.log('Open it in Obsidian (Open another vault → Open folder as vault), then enable community plugins.');

function gradientPng(width, height, [r, g, b]) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const shade = 0.6 + (0.4 * (x + y)) / (width + height);
      row.set([r * shade, g * shade, b * shade].map(Math.round), 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function crc32(bytes) {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
