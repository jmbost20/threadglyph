import { SCHEMA_VERSION, type TextAnchor, type ThreadRecord } from '../model/types';
import { isSafeId } from './paths';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => Number.isInteger(v);

function checkMessage(m: unknown, i: number): string | null {
  if (!isObj(m)) return `messages[${i}] is not an object`;
  if (!isSafeId(m.id)) return `messages[${i}].id is invalid`;
  if (!isObj(m.author) || !isStr(m.author.name) || (m.author.kind !== 'human' && m.author.kind !== 'ai')) {
    return `messages[${i}].author is invalid`;
  }
  if (m.origin !== 'human' && m.origin !== 'ai' && m.origin !== 'ai-edited') return `messages[${i}].origin is invalid`;
  if (!isStr(m.createdAt) || !isStr(m.body)) return `messages[${i}] is missing createdAt/body`;
  if (m.editedAt !== undefined && !isStr(m.editedAt)) return `messages[${i}].editedAt is invalid`;
  if (!Array.isArray(m.revisions) || !m.revisions.every((r) => isObj(r) && isStr(r.body) && isStr(r.replacedAt))) {
    return `messages[${i}].revisions is invalid`;
  }
  return null;
}

function parseJson(raw: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
}

export function parseThread(raw: string): Parsed<ThreadRecord> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const t = json.value;
  if (!isObj(t)) return { ok: false, error: 'record is not an object' };
  if (t.schema !== SCHEMA_VERSION) return { ok: false, error: `unsupported schema ${JSON.stringify(t.schema)}` };
  if (!isSafeId(t.id)) return { ok: false, error: 'id is invalid' };
  if (!isStr(t.notePath) || !t.notePath) return { ok: false, error: 'notePath is invalid' };
  if (t.anchorKind !== 'text' && t.anchorKind !== 'image') return { ok: false, error: 'anchorKind is invalid' };
  if (t.status !== 'open' && t.status !== 'resolved') return { ok: false, error: 'status is invalid' };
  if (!isStr(t.createdAt) || !isStr(t.updatedAt)) return { ok: false, error: 'timestamps are invalid' };
  if (!isInt(t.revision) || (t.revision as number) < 1) return { ok: false, error: 'revision is invalid' };
  if (!Array.isArray(t.messages) || t.messages.length === 0) return { ok: false, error: 'messages are missing' };
  for (let i = 0; i < t.messages.length; i++) {
    const problem = checkMessage(t.messages[i], i);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: t as unknown as ThreadRecord };
}

export function parseAnchor(raw: string): Parsed<TextAnchor> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const a = json.value;
  if (!isObj(a)) return { ok: false, error: 'anchor is not an object' };
  if (a.schema !== SCHEMA_VERSION) return { ok: false, error: `unsupported schema ${JSON.stringify(a.schema)}` };
  if (!isSafeId(a.threadId) || (a.kind !== 'text' && a.kind !== 'image')) {
    return { ok: false, error: 'anchor identity is invalid' };
  }
  if (a.kind === 'image' ? !isStr(a.imagePath) || !a.imagePath : a.imagePath !== undefined) {
    return { ok: false, error: 'anchor imagePath is invalid' };
  }
  if (!isStr(a.notePath) || !isStr(a.quote) || !isStr(a.prefix) || !isStr(a.suffix) || !isInt(a.lineHint)) {
    return { ok: false, error: 'anchor fields are invalid' };
  }
  return { ok: true, value: a as unknown as TextAnchor };
}

export const serialize = (value: ThreadRecord | TextAnchor): string => `${JSON.stringify(value, null, 2)}\n`;
