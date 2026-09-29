import type { TextAnchor, ThreadRecord } from '../model/types';
import { parseAnchor, parseThread } from './schema';

/**
 * Whole-vault backups of Threadglyph data, for rollback and moving between vaults.
 *
 * A backup holds anchors, which quote note text, so it is written to the
 * local-only `.threadglyph/exports` folder, never beside the tracked records.
 * Restoring validates every record and only adds threads that do not exist;
 * it never overwrites or deletes anything.
 */

export const EXPORTS_DIR = '.threadglyph/exports';
export const EXPORT_FORMAT = 'threadglyph-export';
export const EXPORT_VERSION = 1;

export function exportFileName(now: Date): string {
  return `${EXPORTS_DIR}/threadglyph-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function buildExport(threads: ThreadRecord[], anchors: TextAnchor[], now: Date): string {
  return `${JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now.toISOString(), threads, anchors }, null, 2)}\n`;
}

export interface ParsedExport {
  threads: ThreadRecord[];
  anchors: Map<string, TextAnchor>;
  /** Records that failed validation and will not be restored. */
  invalid: number;
}

export function parseExport(raw: string): { ok: true; value: ParsedExport } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
  const d = data as { format?: unknown; version?: unknown; threads?: unknown; anchors?: unknown } | null;
  if (!d || d.format !== EXPORT_FORMAT) return { ok: false, error: 'not a Threadglyph backup' };
  if (d.version !== EXPORT_VERSION) return { ok: false, error: `unsupported backup version ${JSON.stringify(d.version)}` };
  if (!Array.isArray(d.threads) || !Array.isArray(d.anchors)) return { ok: false, error: 'backup is missing its records' };

  let invalid = 0;
  const threads: ThreadRecord[] = [];
  for (const t of d.threads) {
    const parsed = parseThread(JSON.stringify(t));
    if (parsed.ok) threads.push(parsed.value);
    else invalid++;
  }
  const anchors = new Map<string, TextAnchor>();
  for (const a of d.anchors) {
    const parsed = parseAnchor(JSON.stringify(a));
    if (parsed.ok) anchors.set(parsed.value.threadId, parsed.value);
    else invalid++;
  }
  return { ok: true, value: { threads, anchors, invalid } };
}
