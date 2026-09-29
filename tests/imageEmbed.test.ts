import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  embedAtSelection,
  extensionOf,
  findImageEmbeds,
  imageSupport,
  isRemote,
  prepareImage,
  sniffImage,
} from '../src/anchor/imageEmbed';

// Synthetic headers only; no real images are used anywhere in the tests.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 7]);

const doc = [
  'Intro ![[diagram.png]] and ![[Photos/My trip ü.JPG|300]] here.',
  '![alt text](<assets/with space.webp> "Title") ![](assets/%C3%BCber.jpeg)',
  '![[notes.md]] ![[scan.heic]] ![](https://example.com/remote.png) ![[diagram.png#crop]]',
].join('\n');

describe('image embeds', () => {
  it('finds wiki and Markdown image embeds with their links cleaned', () => {
    const embeds = findImageEmbeds(doc);
    expect(embeds.map((e) => e.link)).toEqual([
      'diagram.png',
      'Photos/My trip ü.JPG',
      'assets/with space.webp',
      'assets/über.jpeg',
      'scan.heic',
      'https://example.com/remote.png',
      'diagram.png',
    ]);
    expect(doc.slice(embeds[1].from, embeds[1].to)).toBe('![[Photos/My trip ü.JPG|300]]');
    expect(doc.slice(embeds[2].from, embeds[2].to)).toBe('![alt text](<assets/with space.webp> "Title")');
  });

  it('keeps a link with invalid percent-encoding as written', () => {
    expect(findImageEmbeds('![](bad%E0.png)')[0].link).toBe('bad%E0.png');
  });

  it('picks the embed under the cursor or the only one inside a selection', () => {
    const at = doc.indexOf('![[diagram.png]]');
    const end = at + '![[diagram.png]]'.length;
    expect(embedAtSelection(doc, at, at)?.link).toBe('diagram.png');
    expect(embedAtSelection(doc, end, end)?.link).toBe('diagram.png');
    expect(embedAtSelection(doc, at + 4, at + 8)?.link).toBe('diagram.png');
    expect(embedAtSelection(doc, 0, end + 3)?.link).toBe('diagram.png');
    expect(embedAtSelection(doc, 0, doc.indexOf('here'))).toBeNull();
    expect(embedAtSelection(doc, 1, 2)).toBeNull();
  });

  it('reads extensions and recognises remote links', () => {
    expect(extensionOf('a/b.c/Pic.PNG')).toBe('png');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('noext')).toBe('');
    expect(isRemote('https://x/y.png')).toBe(true);
    expect(isRemote('file:///etc/passwd.png')).toBe(true);
    expect(isRemote('folder/y.png')).toBe(false);
  });

  it('supports PNG, JPEG and WebP and explains everything else', () => {
    expect(imageSupport('a.png')).toEqual({ ok: true, mediaType: 'image/png' });
    expect(imageSupport('a.JPG')).toEqual({ ok: true, mediaType: 'image/jpeg' });
    expect(imageSupport('a.webp')).toEqual({ ok: true, mediaType: 'image/webp' });
    expect(imageSupport('a.heic')).toEqual({ ok: false, reason: expect.stringMatching(/^HEIC images are not supported yet/) });
    expect(imageSupport('a.pdf')).toMatchObject({ ok: false, reason: expect.stringMatching(/^PDF/) });
    expect(imageSupport('a.svg')).toMatchObject({ ok: false, reason: expect.stringMatching(/^SVG/) });
    expect(imageSupport('a.xyz')).toMatchObject({ ok: false, reason: expect.stringMatching(/^XYZ/) });
    expect(imageSupport('noext')).toMatchObject({ ok: false, reason: expect.stringMatching(/^this file type/) });
    expect(imageSupport('https://x/y.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/remote/) });
  });

  it('identifies image bytes by signature', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<svg/>'))).toBeNull();
  });
});

describe('preparing an image for a vision request', () => {
  it('encodes the exact bytes with the type the content really has', () => {
    const result = prepareImage('pics/a.png', PNG);
    expect(result).toEqual({
      ok: true,
      image: { path: 'pics/a.png', mediaType: 'image/png', data: Buffer.from(PNG).toString('base64'), bytes: PNG.length },
    });
    // A PNG saved with a .jpg name is sent as what it is.
    expect(prepareImage('renamed.jpg', PNG)).toMatchObject({ ok: true, image: { mediaType: 'image/png' } });
  });

  it('encodes large images without overflowing the call stack', () => {
    const big = new Uint8Array(200_000);
    big.set(JPEG);
    const result = prepareImage('big.jpg', big);
    expect(result.ok && Buffer.from(result.image.data, 'base64').equals(Buffer.from(big))).toBe(true);
  });

  it('refuses unsupported, empty, oversized and corrupted files', () => {
    expect(prepareImage('a.heic', PNG)).toMatchObject({ ok: false, reason: expect.stringMatching(/HEIC/) });
    expect(prepareImage('a.png', new Uint8Array())).toEqual({ ok: false, reason: 'a.png is empty.' });
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(PNG);
    expect(prepareImage('a.png', huge)).toEqual({ ok: false, reason: 'a.png is 5.0 MB; images sent to AI must be 5 MB or smaller.' });
    expect(prepareImage('a.png', new TextEncoder().encode('not an image'))).toEqual({
      ok: false,
      reason: 'a.png does not contain valid PNG, JPEG or WebP data.',
    });
  });
});
