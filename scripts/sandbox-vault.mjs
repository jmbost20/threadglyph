#!/usr/bin/env node
/**
 * Creates (or refreshes) a disposable Obsidian vault for manual testing and
 * links this plugin's build output into it. Contains synthetic notes only.
 *
 *   npm run build && npm run sandbox [-- <vault-path>]
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

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
  'Images.md': `# Image threads

Put the cursor on an image embed (click just after the image) and run **Threadglyph: Comment on selection**.

![[Sandbox sky.png]]

The same picture twice, smaller: ![[Sandbox sky.png|120]]

A Markdown-style embed: ![a meadow](<Attachments/Sandbox meadow.png>)

Unsupported format (shows a clear message): ![[Not supported.heic]]

Missing file: ![[Nowhere.png]]
`,
};

for (const [name, body] of Object.entries(notes)) {
  const path = join(vault, name);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, body);
}

// Synthetic images: flat gradients drawn here, so no real photo ever enters the sandbox.
const images = {
  'Sandbox sky.png': [90, 140, 220],
  'Attachments/Sandbox meadow.png': [80, 170, 90],
};
for (const [name, rgb] of Object.entries(images)) {
  const path = join(vault, name);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, gradientPng(240, 140, rgb));
}
const heic = join(vault, 'Not supported.heic');
if (!existsSync(heic)) writeFileSync(heic, 'placeholder, not a real HEIC file');

const pluginDir = join(vault, '.obsidian', 'plugins', 'threadglyph');
mkdirSync(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const target = join(pluginDir, file);
  if (existsSync(target) || isLink(target)) rmSync(target);
  symlinkSync(join(repo, file), target);
}

const communityPlugins = join(vault, '.obsidian', 'community-plugins.json');
if (!existsSync(communityPlugins)) writeFileSync(communityPlugins, JSON.stringify(['threadglyph'], null, 2));

// Sandbox-only shortcuts mirroring the main vault's comment key (Cmd/Ctrl+/). The plugin
// itself ships without default hotkeys so it never collides with Agent Comments.
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
