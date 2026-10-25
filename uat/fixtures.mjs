/**
 * Synthetic notes for the Threadglyph UAT, copied from scripts/sandbox-vault.mjs (the plugin's
 * own sandbox samples), plus shared helpers. No real note ever enters the UAT sandbox.
 */
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

export const DIR = 'Test data/Threadglyph samples';
export const WELCOME = `${DIR}/Welcome.md`;

export const welcome = `# Welcome to the Threadglyph sandbox

Select any sentence in this note and run **Threadglyph: Comment on selection**.

The same phrase appears twice: repeat me. And again: repeat me.

- A list item worth discussing.
- Another item with **formatting** inside.
`;

export const images = `# Image threads

Each image has a title line under it with a **Comment** button. You can also put the cursor on an embed and run **Threadglyph: Comment on selection**.

![[Sandbox sky.png]]

With a title in the alias: ![[Sandbox sky.png|Evening sky|200]]

The same picture twice, smaller: ![[Sandbox sky.png|120]]

A Markdown-style embed: ![a meadow](<Attachments/Sandbox meadow.png>)

Unsupported format (shows a clear message): ![[Not supported.heic]]

Missing file: ![[Nowhere.png]]
`;

export const imageTitles = `# Image titles

Every image below shows a title line with a **Comment** button. The title comes from the alias or alt text, else the file name. Nothing is written into this note.

![[Sandbox sky.png|Evening sky]]

![[Attachments/Sandbox meadow.png|200]]

![A green meadow](<Attachments/Sandbox meadow.png>)
`;

export const inlineComments = `# Garden plan (inline comments sample)

Run **Threadglyph: Import inline comments from this note**. The note is not changed.

We should {==plant the tomatoes early==}{>>user|2026-09-16 14:20|question: Is April too soon here?<<}{>>Local|2026-09-16 14:21|reply: Frost can still hit in April; mid-May is safer.<<}{>>user|2026-09-16 14:25|react: 👍 #1<<} this year.

Also {==compost the fallen leaves==}{>>user|2026-09-17 09:00|important: Shred them first so they break down faster.<<}{>>user|2026-09-17 09:05|resolve: <<} before winter.

{==Water deeply twice a week==}{>>Gemini|2026-09-18 18:30|suggest: Water deeply once or twice a week, depending on rain.<<} rather than a little every day.
`;

/** Flat gradients drawn here, so no real photo ever enters the sandbox (same as the plugin's sandbox). */
export function gradientPng(width, height, [r, g, b]) {
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
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
  for (const byte of bytes) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
  return ~c >>> 0;
}

export const imageFiles = () => ({
  [`${DIR}/Sandbox sky.png`]: gradientPng(240, 140, [90, 140, 220]),
  [`${DIR}/Attachments/Sandbox meadow.png`]: gradientPng(240, 140, [80, 170, 90]),
  [`${DIR}/Not supported.heic`]: 'placeholder, not a real HEIC file',
});

// ── reading the panel ──
export const cards = (s) => s.eval(() => [...document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)')].map((c) => ({
  n: c.querySelector('.tg-card-number')?.textContent ?? null,
  quote: c.querySelector('.tg-quote')?.textContent ?? null,
  messages: [...c.querySelectorAll('.tg-message .tg-message-body')].map((m) => m.textContent),
  resolved: c.classList.contains('tg-card-resolved'),
  focused: c.classList.contains('tg-card-focused'),
  detached: !!c.querySelector('.tg-anchor-problem, .tg-problem'),
})));
export const headerMeta = (s) => s.eval(() => document.querySelector('.tg-panel .tg-header-meta')?.textContent ?? null);
export const threadFiles = async (s) => (await s.files()).filter((p) => p.startsWith('threadglyph/threads/'));

/**
 * Opens a note with the quick switcher and waits for the panel to show it. The panel refreshes
 * 300 ms after a file opens (debounced), so a screenshot taken straight away still reads "Open a
 * note to see its threads."
 */
export async function open(s, path) {
  // Setup, not under test: bring the panel's tab forward, so every screenshot shows it (the
  // sidebar otherwise keeps whichever tab the last scenario left open).
  await s.eval(() => app.commands.executeCommandById('threadglyph:open-panel'));
  await s.waitFor(() => [...document.querySelectorAll('.tg-panel')].some((p) => p.offsetParent !== null), null, { what: 'the Threadglyph panel' });
  await s.openNote(path);
  const name = path.split('/').pop().replace(/\.md$/, '');
  await s.waitFor((n) => {
    const panel = [...document.querySelectorAll('.tg-panel')].find((p) => p.offsetParent !== null);
    if (!panel) return true; // no panel on screen yet: nothing to catch up
    return !!panel.querySelector('.tg-header-title')?.textContent?.includes(n) && ![...panel.querySelectorAll('.tg-empty')].some((e) => /^(Open a note|Loading)/.test(e.textContent));
  }, name, { what: `the panel to show "${name}"` });
}

/** Comments on `text` the way the owner does: drag-select it, ⌘/, type, ⌘↩. */
export async function comment(s, text, body, { nth = 0 } = {}) {
  const before = (await cards(s)).length;
  await s.selectText(text, nth);
  await s.press('Meta+/');
  await s.waitFor(() => document.activeElement?.matches('.tg-card-new textarea'), null, { what: 'the new-thread box' });
  await s.type(body);
  await s.press('Meta+Enter');
  await s.waitFor((n) => document.querySelectorAll('.tg-panel .tg-card:not(.tg-card-new)').length === n, before + 1, { what: 'the new thread card' });
}

/** Clicks back into the note, so editor keys go to it (the panel keeps focus after commenting). */
export async function focusNote(s, line) {
  await s.clickLine(line);
}

export const ASK = `${DIR}/Ask AI playground.md`;

/** The Ask AI playground note from scripts/sandbox-vault.mjs. */
export const askPlayground = `# Ask AI playground

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
`;

/** Plugin settings with Ask AI on. Only Local is ever sent to, and it runs on this Mac. */
export const aiSettings = (extra = {}) => ({
  authorName: 'Me',
  aiEnabled: true,
  assistants: { local: true, gemini: true, claude: true },
  defaultAssistant: 'local',
  ollamaHost: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  aiTimeoutSeconds: 180,
  ...extra,
});
