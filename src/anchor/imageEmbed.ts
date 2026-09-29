/**
 * Image embeds in note source, and the rules for which images Threadglyph can
 * anchor to or send to a vision model.
 *
 * Supported: local PNG, JPEG and WebP. These are the formats every mainstream
 * vision API accepts and Obsidian previews natively. Anything else gets a
 * clear refusal instead of a silent conversion.
 */

export interface ImageEmbed {
  /** Source offsets of the whole embed markup, e.g. `![[pic.png|300]]`. */
  from: number;
  to: number;
  /** The link as written, without size/alias suffixes or the `#` subpath. */
  link: string;
}

export type ImageSupport =
  | { ok: true; mediaType: ImageMediaType }
  | { ok: false; reason: string };

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Largest image sent to a model, in bytes. Chosen from the strictest common
 * provider cap (5 MB per image for the Claude API); larger images can still be
 * commented on by people, they just can't be attached to an AI request.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SUPPORTED: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Formats people commonly embed that we recognise but do not support yet. */
const UNSUPPORTED: Record<string, string> = {
  heic: 'HEIC',
  heif: 'HEIF',
  pdf: 'PDF',
  svg: 'SVG',
  gif: 'GIF',
  bmp: 'BMP',
  tif: 'TIFF',
  tiff: 'TIFF',
  avif: 'AVIF',
};

const EMBED = /!\[\[([^\]\n]+?)\]\]|!\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isRemote(link: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(link);
}

function cleanLink(raw: string, wiki: boolean): string {
  let link = raw.trim();
  if (wiki) link = link.split('|')[0];
  else if (link.startsWith('<') && link.endsWith('>')) link = link.slice(1, -1);
  if (!wiki && !isRemote(link)) {
    try {
      link = decodeURIComponent(link);
    } catch {
      // Keep the link as written if it is not valid percent-encoding.
    }
  }
  return link.split('#')[0].trim();
}

/** Every embed whose target looks like an image file (by extension), in source order. */
export function findImageEmbeds(doc: string): ImageEmbed[] {
  const found: ImageEmbed[] = [];
  for (const m of doc.matchAll(EMBED)) {
    const wiki = m[1] !== undefined;
    const link = cleanLink(wiki ? m[1] : m[2], wiki);
    const ext = extensionOf(link);
    if (!(ext in SUPPORTED) && !(ext in UNSUPPORTED)) continue;
    found.push({ from: m.index, to: m.index + m[0].length, link });
  }
  return found;
}

/**
 * The embed a selection refers to: the one containing the cursor or selection,
 * or the single embed inside a larger selection. Null when there is none or
 * the choice would be a guess.
 */
export function embedAtSelection(doc: string, from: number, to: number): ImageEmbed | null {
  const embeds = findImageEmbeds(doc);
  const containing = embeds.find((e) => e.from <= from && to <= e.to);
  if (containing) return containing;
  const inside = embeds.filter((e) => from <= e.from && e.to <= to);
  return inside.length === 1 ? inside[0] : null;
}

/** Whether an image path can be anchored to, judged by its extension. */
export function imageSupport(path: string): ImageSupport {
  if (isRemote(path)) {
    return { ok: false, reason: 'Threadglyph does not fetch remote images. Save the image into the vault first.' };
  }
  const ext = extensionOf(path);
  const mediaType = SUPPORTED[ext];
  if (mediaType) return { ok: true, mediaType };
  const name = UNSUPPORTED[ext] ?? (ext ? ext.toUpperCase() : 'this file type');
  return {
    ok: false,
    reason: `${name} images are not supported yet. Threadglyph can comment on PNG, JPEG and WebP images.`,
  };
}

/** Identifies an image from its first bytes, so a renamed or corrupted file is never sent as something it is not. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export interface PreparedImage {
  path: string;
  mediaType: ImageMediaType;
  /** Base64 of the exact file bytes. */
  data: string;
  bytes: number;
}

export type PrepareResult = { ok: true; image: PreparedImage } | { ok: false; reason: string };

/** Validates real image bytes for a vision request: supported type, matching content, within the size cap. */
export function prepareImage(path: string, bytes: Uint8Array): PrepareResult {
  const support = imageSupport(path);
  if (!support.ok) return support;
  if (bytes.length === 0) return { ok: false, reason: `${path} is empty.` };
  if (bytes.length > MAX_IMAGE_BYTES) {
    const mb = (bytes.length / 1024 / 1024).toFixed(1);
    return { ok: false, reason: `${path} is ${mb} MB; images sent to AI must be 5 MB or smaller.` };
  }
  const actual = sniffImage(bytes);
  if (!actual) return { ok: false, reason: `${path} does not contain valid PNG, JPEG or WebP data.` };
  return { ok: true, image: { path, mediaType: actual, data: toBase64(bytes), bytes: bytes.length } };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
