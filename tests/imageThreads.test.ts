import { describe, expect, it } from 'vitest';
import { captureTextAnchor } from '../src/anchor/textAnchor';
import { ThreadController } from '../src/controller';
import { createThread } from '../src/model/thread';
import type { TextAnchor } from '../src/model/types';
import { parseAnchor, parseThread, serialize } from '../src/storage/schema';
import { ThreadStore } from '../src/storage/threadStore';
import { anchorProblem, anchorState, buildThreadViews } from '../src/ui/viewModel';
import { MemoryFs, fakeClock, human } from './helpers';

const note = 'Notes/trip.md';
const doc = 'Before.\n![[Photos/view.png]]\nAfter the photo.\n';
const embed = '![[Photos/view.png]]';
const range = (s: string, d = doc) => [d.indexOf(s), d.indexOf(s) + s.length] as const;

/** Stand-in for Obsidian's link resolution: bare names resolve inside Photos/. */
const resolveLink = (link: string) => (link.includes('/') ? link : `Photos/${link}`);

async function setup() {
  const fs = new MemoryFs();
  const clock = fakeClock();
  const store = new ThreadStore(fs, clock);
  const ctl = new ThreadController(store, () => human, clock);
  return { fs, clock, store, ctl };
}

async function imageThread() {
  const env = await setup();
  expect(env.ctl.beginImageThread(note, doc, ...range(embed), 'Photos/view.png')).toEqual({ ok: true });
  const created = await env.ctl.commitThread('What is this view?');
  if (!created.thread) throw new Error('setup failed');
  return { ...env, thread: created.thread };
}

describe('image threads', () => {
  it('creates an image thread whose tracked record names no file and quotes no note text', async () => {
    const { fs, store, thread } = await imageThread();
    expect(thread.anchorKind).toBe('image');
    expect(store.anchorFor(thread.id)).toMatchObject({ kind: 'image', imagePath: 'Photos/view.png', quote: embed });
    const tracked = [...fs.files].find(([p]) => p.startsWith('threadglyph/'))![1];
    expect(tracked).not.toContain('view.png');
    expect(tracked).not.toContain('Before');
  });

  it('refuses unsupported formats before the user types anything', async () => {
    const { ctl } = await setup();
    const heic = 'x ![[scan.heic]] y';
    expect(ctl.beginImageThread(note, heic, ...range('![[scan.heic]]', heic), 'scan.heic')).toEqual({
      ok: false,
      message: expect.stringMatching(/HEIC images are not supported yet/),
    });
    expect(ctl.pending).toBeNull();
  });

  it('reattaches an image thread only to an image, keeping its messages', async () => {
    const { ctl, store, thread } = await imageThread();
    const moved = 'New intro.\n![[Photos/other.webp]]\n';
    expect(await ctl.reattach(thread.id, note, moved, 0, 4)).toEqual({
      ok: false,
      message: 'Put the cursor on an image embed, then reattach.',
    });
    expect(await ctl.reattach(thread.id, note, moved, ...range('![[Photos/other.webp]]', moved), 'x.gif')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/GIF/),
    });
    const ok = await ctl.reattach(thread.id, note, moved, ...range('![[Photos/other.webp]]', moved), 'Photos/other.webp');
    expect(ok).toEqual({ ok: true });
    expect(store.anchorFor(thread.id)).toMatchObject({ kind: 'image', imagePath: 'Photos/other.webp' });
    expect(store.get(thread.id)!.messages[0].body).toBe('What is this view?');
  });

  it('reattaches a text thread as text even if an image path is offered', async () => {
    const { ctl, store } = await setup();
    const text = 'Some words here.';
    ctl.beginThread(note, text, ...range('words', text));
    const { thread } = await ctl.commitThread('Hm');
    await ctl.reattach(thread!.id, note, text, ...range('here', text), 'ignored.png');
    expect(store.anchorFor(thread!.id)).toMatchObject({ kind: 'text', quote: 'here' });
    expect(store.anchorFor(thread!.id)!.imagePath).toBeUndefined();
  });

  it('follows the image file and its folder through renames', async () => {
    const { store, thread } = await imageThread();
    await store.renameNote('Photos/view.png', 'Photos/vista.png');
    expect(store.anchorFor(thread.id)!.imagePath).toBe('Photos/vista.png');
    await store.renameNote('Photos', 'Archive/Photos');
    expect(store.anchorFor(thread.id)).toMatchObject({ imagePath: 'Archive/Photos/vista.png', notePath: note });
    await store.renameNote('Notes/trip.md', 'Notes/journey.md');
    expect(store.anchorFor(thread.id)).toMatchObject({ imagePath: 'Archive/Photos/vista.png', notePath: 'Notes/journey.md' });
  });
});

describe('image anchor resolution', () => {
  const anchor: TextAnchor = {
    ...captureTextAnchor('thread-000001', note, doc, ...range(embed)),
    kind: 'image',
    imagePath: 'Photos/view.png',
  };

  it('finds the embed as captured', () => {
    expect(anchorState(doc, anchor, resolveLink)).toEqual({ kind: 'found', from: doc.indexOf(embed), to: doc.indexOf(embed) + embed.length });
  });

  it('finds the same file when the embed markup changed', () => {
    const resized = 'Before.\n![[view.png|400]]\nAfter.\n';
    expect(anchorState(resized, anchor, resolveLink)).toEqual({ kind: 'found', ...{ from: 8, to: 8 + '![[view.png|400]]'.length } });
    expect(anchorState(resized, anchor)).toEqual({ kind: 'missing' });
  });

  it('reports ambiguity when the file is embedded twice, and missing when it is gone', () => {
    const twice = '![[view.png|200]] and ![[Photos/view.png|300]]';
    expect(anchorState(twice, anchor, resolveLink)).toEqual({ kind: 'ambiguous', count: 2 });
    expect(anchorState('No images now.', anchor, resolveLink)).toEqual({ kind: 'missing' });
    const repeated = `${embed}\n${embed}`;
    expect(anchorState(repeated, { ...anchor, prefix: '', suffix: '' }, resolveLink)).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('explains image anchor problems in image terms', () => {
    expect(anchorProblem({ kind: 'ambiguous', count: 3 }, true)).toMatch(/embedded 3 times/);
    expect(anchorProblem({ kind: 'missing' }, true)).toMatch(/no longer embedded/);
    expect(anchorProblem({ kind: 'no-anchor' }, true)).toMatch(/no saved anchor/);
  });

  it('exposes the image path on thread views', () => {
    const thread = { ...createThread(note, human, 'Hi', fakeClock(), 'image'), id: 'thread-000001' };
    const [view] = buildThreadViews({ forNote: () => [thread], anchorFor: () => anchor }, note, doc, resolveLink);
    expect(view.imagePath).toBe('Photos/view.png');
  });
});

describe('image schema', () => {
  const anchor = { ...captureTextAnchor('thread-000001', note, doc, ...range(embed)), kind: 'image', imagePath: 'Photos/view.png' };

  it('accepts image threads and image anchors with a path', () => {
    const thread = createThread(note, human, 'Hi', fakeClock(), 'image');
    expect(parseThread(serialize(thread))).toMatchObject({ ok: true, value: { anchorKind: 'image' } });
    expect(parseAnchor(JSON.stringify(anchor)).ok).toBe(true);
  });

  it('rejects image anchors without a path and text anchors with one', () => {
    expect(parseAnchor(JSON.stringify({ ...anchor, imagePath: '' }))).toEqual({ ok: false, error: 'anchor imagePath is invalid' });
    expect(parseAnchor(JSON.stringify({ ...anchor, imagePath: 7 })).ok).toBe(false);
    expect(parseAnchor(JSON.stringify({ ...anchor, kind: 'text' })).ok).toBe(false);
    expect(parseAnchor(JSON.stringify({ ...anchor, kind: 'video' })).ok).toBe(false);
    const thread = createThread(note, human, 'Hi', fakeClock());
    expect(parseThread(JSON.stringify({ ...thread, anchorKind: 'video' })).ok).toBe(false);
  });
});
