/** Largest amount of note text sent as extra context, in characters. */
export const MAX_CONTEXT_CHARS = 40_000;

const HEADING = /^(#{1,6})\s+(.*)$/;

export interface NoteContext {
  label: string;
  text: string;
}

/**
 * The line after a note's properties block (YAML front matter between `---`
 * lines at the very top), or 0 when there is none. A `#` line inside it is a
 * YAML comment, not a heading.
 */
function propertiesEnd(lines: string[]): number {
  if (lines[0]?.trimEnd() !== '---') return 0;
  const close = lines.findIndex((line, i) => i > 0 && (line.trimEnd() === '---' || line.trimEnd() === '...'));
  return close === -1 ? 0 : close + 1;
}

/** Where the Markdown section containing `offset` starts and ends in `doc`, and its label. */
export function sectionRange(doc: string, offset: number): { from: number; to: number; label: string } {
  const lines = doc.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }
  const headings: { line: number; level: number; title: string }[] = [];
  const properties = propertiesEnd(lines);
  let fenced = false;
  lines.forEach((line, i) => {
    if (i < properties) return;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m) headings.push({ line: i, level: m[1].length, title: m[2].trim() });
  });
  let lineOfOffset = 0;
  while (lineOfOffset + 1 < starts.length && starts[lineOfOffset + 1] <= offset) lineOfOffset++;
  const owner = [...headings].reverse().find((h) => h.line <= lineOfOffset);
  const end = headings.find((h) => h.line > (owner?.line ?? -1) && (!owner || h.level <= owner.level));
  return {
    from: owner ? starts[owner.line] : 0,
    to: end ? starts[end.line] : doc.length,
    label: owner ? `The section “${owner.title}”` : 'The text before the first heading',
  };
}

/**
 * The Markdown section containing `offset`: from the nearest heading above it
 * to the next heading of the same or a higher level. Headings inside fenced
 * code blocks are ignored.
 */
export function sectionAround(doc: string, offset: number): NoteContext {
  const { from, to, label } = sectionRange(doc, offset);
  return limit({ label, text: doc.slice(from, to).trimEnd() });
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
