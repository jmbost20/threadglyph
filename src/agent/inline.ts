import { sectionRange } from '../ai/context';
import { listBlockAt, regionAt, type Region } from './target';

/** An "@agent …" request typed on a line of a note. */
export interface InlineRequest {
  instruction: string;
  /** The request text removed on Accept: " @agent …", or the whole line when nothing else is on it. */
  removeFrom: number;
  removeTo: number;
  lineFrom: number;
}

const REQUEST = /(^|\s)@agent\b[ \t]*(.*)$/i;
/** A line that is only a list marker (and checkbox) once the request is gone. */
const BARE = /^\s*(?:(?:[-*+]|\d+[.)])\s*(?:\[.\]\s*)?)?$/;

/** The request on the line containing `offset`, if the line has one. */
export function findInlineRequest(doc: string, offset: number): InlineRequest | null {
  const lineFrom = doc.lastIndexOf('\n', offset - 1) + 1;
  const end = doc.indexOf('\n', offset);
  const lineTo = end === -1 ? doc.length : end;
  const line = doc.slice(lineFrom, lineTo);
  const match = REQUEST.exec(line);
  if (!match) return null;
  const kept = line.slice(0, match.index + match[1].length).trimEnd();
  const instruction = match[2].trim();
  if (!BARE.test(kept)) return { instruction, removeFrom: lineFrom + kept.length, removeTo: lineTo, lineFrom };
  // Nothing else on the line: remove it with one of its line breaks.
  if (lineTo < doc.length) return { instruction, removeFrom: lineFrom, removeTo: lineTo + 1, lineFrom };
  return { instruction, removeFrom: Math.max(0, lineFrom - 1), removeTo: lineTo, lineFrom };
}

/**
 * What an inline request may change, with the request removed: the list item
 * it sits on and everything under it, or else the section around it.
 * `region` is the original text (request included), replaced on Accept;
 * `base` is what the agent sees and edits.
 */
export function inlineTarget(doc: string, request: InlineRequest): { region: Region; base: string } {
  const clean = doc.slice(0, request.removeFrom) + doc.slice(request.removeTo);
  const at = Math.min(request.removeFrom, clean.length);
  const keptLine = request.removeFrom > request.lineFrom;
  // With its whole line removed, the request belonged to the line before it.
  const onLine = keptLine ? request.lineFrom : Math.max(0, request.removeFrom - 1);
  const block = keptLine ? listBlockAt(clean, onLine) : null;
  let from: number;
  let to: number;
  let label: string;
  if (block) {
    ({ from, to } = block);
    label = 'The list item and everything under it';
  } else {
    const section = sectionRange(clean, onLine);
    from = section.from;
    to = section.from + clean.slice(section.from, section.to).replace(/\s+$/, '').length;
    label = section.label;
  }
  from = Math.min(from, at);
  to = Math.max(to, at);
  const removed = request.removeTo - request.removeFrom;
  return {
    base: clean.slice(from, to),
    region: regionAt(doc, from, to + removed, label),
  };
}
