import { sectionRange } from '../ai/context';
import type { ContextScope } from '../ai/session';

/** A stretch of a note the agent may change, with the text it held when the request was built. */
export interface Region {
  from: number;
  to: number;
  text: string;
  label: string;
  /** Text just around it, so a moved region is found again but an identical copy elsewhere is not taken for it. */
  before?: string;
  after?: string;
}

/** How much surrounding text identifies a region. */
const CONTEXT_CHARS = 40;

/** `doc[from, to)` as a region, with the text around it. */
export function regionAt(doc: string, from: number, to: number, label: string): Region {
  return {
    from,
    to,
    text: doc.slice(from, to),
    label,
    before: doc.slice(Math.max(0, from - CONTEXT_CHARS), from),
    after: doc.slice(to, to + CONTEXT_CHARS),
  };
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const indentOf = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, '    ').length;

interface Line {
  from: number;
  text: string;
}

function linesOf(doc: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const text of doc.split('\n')) {
    lines.push({ from, text });
    from += text.length + 1;
  }
  return lines;
}

const lineIndex = (lines: Line[], offset: number) => {
  let i = 0;
  while (i + 1 < lines.length && lines[i + 1].from <= offset) i++;
  return i;
};

/** The list item at `offset` with everything nested under it (a parent checkbox and its children). */
export function listBlockAt(doc: string, offset: number): { from: number; to: number } | null {
  const lines = linesOf(doc);
  const first = lineIndex(lines, offset);
  if (!LIST_ITEM.test(lines[first].text)) return null;
  const base = indentOf(lines[first].text);
  let last = first;
  for (let i = first + 1; i < lines.length; i++) {
    const text = lines[i].text;
    if (!text.trim() || indentOf(text) <= base) break;
    last = i;
  }
  return { from: lines[first].from, to: lines[last].from + lines[last].text.length };
}

/** Whole lines covering `from`..`to`, without the final line break. */
function fullLines(doc: string, from: number, to: number): { from: number; to: number } {
  const start = doc.lastIndexOf('\n', from - 1) + 1;
  const newline = doc.indexOf('\n', Math.max(to - (to > from ? 1 : 0), from));
  return { from: start, to: newline === -1 ? doc.length : newline };
}

function region(doc: string, from: number, to: number, label: string): Region {
  const text = doc.slice(from, to).replace(/\s+$/, '');
  return regionAt(doc, from, from + text.length, label);
}

/**
 * What an agent request may change, by the scope chosen in the preview:
 * the passage's list block (or its lines), its section, or the whole note.
 */
export function agentTarget(doc: string, from: number, to: number, scope: ContextScope): Region {
  if (scope === 'note') return region(doc, 0, doc.length, 'The whole note');
  if (scope === 'section') {
    const section = sectionRange(doc, from);
    return region(doc, section.from, section.to, section.label);
  }
  const block = listBlockAt(doc, from);
  if (block && block.to >= to) return region(doc, block.from, block.to, 'The list item and everything under it');
  const lines = fullLines(doc, from, to);
  return region(doc, lines.from, lines.to, 'The lines of the passage');
}
