import type { CardDraft, Candidate, ObjectProposal } from './types';

/**
 * Knowledge Objects and cards as Markdown notes. Frontmatter carries the fields
 * the knowledge system reads (Bases views, identity); the body is for reading.
 * Updates only append (evidence, learning history, card links): an owner's
 * edits to the Essence or Key ideas are never overwritten.
 */

export const OBJECTS = 'Objects';
export const CARDS = 'Cards';

/**
 * How far learning has got: `captured` (saved from a passage), `discussed`
 * (the thread has a discussion or an answer), `carded` (cards exist).
 */
export const LEARNING_STATES = ['captured', 'discussed', 'carded'] as const;
export type LearningState = (typeof LEARNING_STATES)[number];

/** The later of two learning states; learning never goes backwards on its own. */
export function advance(current: unknown, next: LearningState): LearningState {
  const at = LEARNING_STATES.indexOf(current as LearningState);
  return at > LEARNING_STATES.indexOf(next) ? (current as LearningState) : next;
}

/** A title usable as a file name in every OS Obsidian runs on. */
export function fileSafe(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return safe || 'Untitled object';
}

const q = (s: string) => JSON.stringify(s);
const list = (items: string[]) => `[${items.map(q).join(', ')}]`;

export interface EvidenceEntry {
  date: string;
  /** The source note's link text, e.g. `Week 3 reading`. */
  noteLink: string;
  threadId: string;
  quote: string | null;
  action: 'knowledge' | 'card';
  instruction: string;
}

function evidenceBlock(e: EvidenceEntry): string {
  const quote = e.quote ? e.quote.trim().split('\n').map((l) => `> ${l}`).join('\n') : '> (image or no passage)';
  return `${quote}\n\n— [[${e.noteLink}]] · thread ${e.threadId.slice(0, 8)} · ${e.date}`;
}

function historyLine(e: EvidenceEntry): string {
  const said = e.instruction ? `: “${e.instruction.replace(/\s+/g, ' ').slice(0, 200)}”` : '';
  return `- ${e.date} · @${e.action} from [[${e.noteLink}]]${said}`;
}

export function renderObject(o: {
  koId: string;
  proposal: ObjectProposal;
  learning: LearningState;
  evidence: EvidenceEntry;
}): string {
  const p = o.proposal;
  const date = o.evidence.date;
  return [
    '---',
    'type: knowledge-object',
    `ko_id: ${o.koId}`,
    `title: ${q(p.title)}`,
    `aliases: ${list(p.aliases)}`,
    `kind: ${q(p.kind)}`,
    `subject_domains: ${list(p.domains)}`,
    'status: current (knowledge)',
    'review_state: provisional',
    `learning_state: ${o.learning}`,
    'origin: threadglyph',
    `created: ${date}`,
    `updated: ${date}`,
    `source_refs: ${list([`[[${o.evidence.noteLink}]]`])}`,
    'card_refs: []',
    '---',
    '',
    '## Essence',
    '',
    p.essence.trim(),
    '',
    '## Key ideas',
    '',
    ...(p.keyIdeas.length ? p.keyIdeas.map((k) => `- ${k.trim()}`) : ['- (none yet)']),
    '',
    '## Evidence',
    '',
    evidenceBlock(o.evidence),
    '',
    '## Learning history',
    '',
    historyLine(o.evidence),
    '',
    '## Cards',
    '',
  ].join('\n');
}

/**
 * Appends `text` at the end of the `## heading` section, adding the section at
 * the end of the note when the owner removed it.
 */
export function appendToSection(markdown: string, heading: string, text: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return `${markdown.replace(/\s*$/, '')}\n\n## ${heading}\n\n${text}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let last = end;
  while (last > start + 1 && !lines[last - 1].trim()) last--;
  const tail = end < lines.length ? [''] : [];
  return [...lines.slice(0, last), '', ...text.split('\n'), ...tail, ...lines.slice(end)].join('\n').replace(/\n*$/, '\n');
}

/** Adds the evidence and a learning-history line for one more request about an existing object. */
export function addEvidence(markdown: string, e: EvidenceEntry, newIdeas: string[]): string {
  let next = appendToSection(markdown, 'Evidence', evidenceBlock(e));
  next = appendToSection(next, 'Learning history', historyLine(e));
  const existing = new Set([...markdown.matchAll(/^- (.*)$/gm)].map((m) => m[1].trim().toLowerCase()));
  const fresh = newIdeas.map((k) => k.trim()).filter((k) => k && !existing.has(k.toLowerCase()));
  if (fresh.length) next = appendToSection(next, 'Key ideas', fresh.map((k) => `- ${k}`).join('\n'));
  return next;
}

export function addCardLinks(markdown: string, cardLinks: string[]): string {
  return cardLinks.length ? appendToSection(markdown, 'Cards', cardLinks.map((l) => `- [[${l}]]`).join('\n')) : markdown;
}

export function renderCard(c: {
  cardId: string;
  card: CardDraft;
  objectLink: string;
  deck: string;
  date: string;
  sourceLink: string;
}): string {
  return [
    '---',
    'type: knowledge-card',
    `card_id: ${c.cardId}`,
    `object: ${q(`[[${c.objectLink}]]`)}`,
    `source: ${q(`[[${c.sourceLink}]]`)}`,
    `deck: ${q(c.deck)}`,
    'delivery: inbox',
    'anki_note_id: null',
    `created: ${c.date}`,
    '---',
    '',
    '## Front',
    '',
    c.card.front.trim(),
    '',
    '## Back',
    '',
    c.card.back.trim(),
    '',
  ].join('\n');
}

/** The front and back of a card note, as the owner may have edited them. */
export function cardSides(markdown: string): CardDraft | null {
  const section = (name: string) => {
    const m = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(markdown);
    return m ? m[1].trim() : '';
  };
  const front = section('Front');
  const back = section('Back');
  return front && back ? { front, back } : null;
}

function frontmatter(markdown: string): string[] {
  if (!markdown.startsWith('---\n')) return [];
  const end = markdown.indexOf('\n---', 4);
  return end === -1 ? [] : markdown.slice(4, end).split('\n');
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  return v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1) : v;
}

/** A frontmatter field as a string or a list (inline `[a, b]` or `- a` lines). */
export function field(markdown: string, key: string): string | string[] | null {
  const lines = frontmatter(markdown);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at === -1) return null;
  const value = lines[at].slice(key.length + 1).trim();
  if (value.startsWith('[')) {
    const inner = value.slice(1, value.lastIndexOf(']'));
    return inner.trim() ? inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(unquote).filter(Boolean) : [];
  }
  if (value) return unquote(value);
  const items: string[] = [];
  for (let i = at + 1; i < lines.length && /^\s+-\s/.test(lines[i]); i++) items.push(unquote(lines[i].replace(/^\s+-\s/, '')));
  return items;
}

/**
 * Sets a frontmatter field to an already rendered YAML value, replacing any
 * block-list lines under it (Obsidian's property editor writes lists that way).
 */
export function setField(markdown: string, key: string, rendered: string): string {
  const lines = frontmatter(markdown);
  if (!lines.length) return markdown;
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  const next = [...lines];
  if (at === -1) next.push(`${key}: ${rendered}`);
  else {
    let end = at + 1;
    while (end < next.length && /^\s+-\s/.test(next[end])) end++;
    next.splice(at, end - at, `${key}: ${rendered}`);
  }
  return `---\n${next.join('\n')}${markdown.slice(4 + lines.join('\n').length)}`;
}

/** Adds `item` to a list field unless it is already there. */
export function addToList(markdown: string, key: string, item: string): string {
  const current = field(markdown, key);
  const items = Array.isArray(current) ? current : current ? [current] : [];
  return items.includes(item) ? markdown : setField(markdown, key, list([...items, item]));
}

/** What retrieval and the review form need from an object note. */
export function summaryOf(path: string, markdown: string): Candidate & { aliases: string[] } {
  const title = field(markdown, 'title');
  const aliases = field(markdown, 'aliases');
  const essence = /^## Essence\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1].trim() ?? '';
  const name = path.split('/').pop()!.replace(/\.md$/, '');
  return {
    path,
    title: typeof title === 'string' && title ? title : name,
    aliases: Array.isArray(aliases) ? aliases : typeof aliases === 'string' && aliases ? [aliases] : [],
    essence,
  };
}

const WORD = /[\p{L}\p{N}]{3,}/gu;
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'what', 'are', 'from', 'was', 'its', 'about', 'card', 'knowledge', 'into', 'have', 'has', 'not', 'but', 'you', 'can']);
const words = (text: string) => new Set((text.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));

/**
 * Existing objects most likely to be the same thing as `text`, best first: a
 * title or alias named in the text counts most, then shared words.
 */
export function rankCandidates(objects: (Candidate & { aliases: string[] })[], text: string, limit = 6): (Candidate & { aliases: string[] })[] {
  const haystack = text.toLowerCase();
  const terms = words(text);
  return objects
    .map((o) => {
      const named = [o.title, ...o.aliases].some((n) => n.length > 2 && haystack.includes(n.toLowerCase())) ? 10 : 0;
      const own = words(`${o.title} ${o.aliases.join(' ')} ${o.essence}`);
      let shared = 0;
      for (const w of own) if (terms.has(w)) shared++;
      return { o, score: named + shared };
    })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.o);
}

/** The object whose title or alias is `name` (ignoring case), if any. */
export function byName<T extends Candidate & { aliases: string[] }>(objects: T[], name: string): T | null {
  const n = name.trim().toLowerCase();
  return objects.find((o) => o.title.toLowerCase() === n || o.aliases.some((a) => a.toLowerCase() === n)) ?? null;
}
