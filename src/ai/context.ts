/** Largest amount of note text sent as extra context, in characters. */
export const MAX_CONTEXT_CHARS = 40_000;

const HEADING = /^(#{1,6})\s+(.*)$/;

export interface NoteContext {
  label: string;
  text: string;
}

/**
 * The Markdown section containing `offset`: from the nearest heading above it
 * to the next heading of the same or a higher level. Headings inside fenced
 * code blocks are ignored.
 */
export function sectionAround(doc: string, offset: number): NoteContext {
  const lines = doc.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }
  const headings: { line: number; level: number; title: string }[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m) headings.push({ line: i, level: m[1].length, title: m[2].trim() });
  });
  let lineOfOffset = 0;
  while (lineOfOffset + 1 < starts.length && starts[lineOfOffset + 1] <= offset) lineOfOffset++;
  const owner = [...headings].reverse().find((h) => h.line <= lineOfOffset);
  const end = headings.find((h) => h.line > (owner?.line ?? -1) && (!owner || h.level <= owner.level));
  const from = owner ? starts[owner.line] : 0;
  const to = end ? starts[end.line] : doc.length;
  return limit({
    label: owner ? `The section “${owner.title}”` : 'The text before the first heading',
    text: doc.slice(from, to).trimEnd(),
  });
}

export function wholeNote(doc: string): NoteContext {
  return limit({ label: 'The whole note', text: doc.trimEnd() });
}

function limit(context: NoteContext): NoteContext {
  if (context.text.length <= MAX_CONTEXT_CHARS) return context;
  return {
    label: `${context.label} (first ${MAX_CONTEXT_CHARS.toLocaleString('en-US')} characters)`,
    text: `${context.text.slice(0, MAX_CONTEXT_CHARS)}\n[…truncated]`,
  };
}
