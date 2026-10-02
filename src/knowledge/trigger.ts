import type { KnowledgeAction } from './types';

/**
 * The action an owner comment asks for: `@card` (knowledge plus cards) wins
 * over `@knowledge`. Mentions inside code, inline code or quoted lines are
 * examples, not requests.
 */
export function requestedAction(body: string): KnowledgeAction | null {
  const plain = body
    .replace(/(^|\n) {0,3}(`{3,}|~{3,})[\s\S]*?(\n {0,3}\2|$)/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  if (/(^|[\s(])@cards?\b/i.test(plain)) return 'card';
  if (/(^|[\s(])@knowledge\b/i.test(plain)) return 'knowledge';
  return null;
}

/** The comment without its action mentions, as the owner's instruction to the worker. */
export function instructionOf(body: string): string {
  return body.replace(/(^|[\s(])@(cards?|knowledge)\b/gi, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}
