import { describe, expect, it } from 'vitest';
import { captureTextAnchor, lineOf, resolveTextAnchor } from '../src/anchor/textAnchor';

const doc = 'Intro line\nThe quick brown fox jumps.\nOutro line\n';
const at = (d: string, s: string) => [d.indexOf(s), d.indexOf(s) + s.length] as const;

describe('text anchors', () => {
  it('captures quote, context and line hint', () => {
    const [from, to] = at(doc, 'brown fox');
    const a = captureTextAnchor('thread-0001', 'a.md', doc, from, to);
    expect(a).toMatchObject({ quote: 'brown fox', lineHint: 1, notePath: 'a.md' });
    expect(a.prefix.endsWith('The quick ')).toBe(true);
    expect(a.suffix.startsWith(' jumps.')).toBe(true);
  });

  it('rejects empty or whitespace selections', () => {
    expect(() => captureTextAnchor('thread-0001', 'a.md', doc, 3, 3)).toThrow(RangeError);
    expect(() => captureTextAnchor('thread-0001', 'a.md', 'a   b', 1, 4)).toThrow(RangeError);
  });

  it('survives text inserted before the anchor', () => {
    const [from, to] = at(doc, 'brown fox');
    const a = captureTextAnchor('thread-0001', 'a.md', doc, from, to);
    const edited = `New paragraph at the top.\n\n${doc}`;
    const r = resolveTextAnchor(edited, a);
    expect(r).toEqual({ status: 'found', from: edited.indexOf('brown fox'), to: edited.indexOf('brown fox') + 9 });
  });

  it('picks the right occurrence of a repeated quote using context', () => {
    const d = 'alpha: see note\nbeta: see note\ngamma\n';
    const second = d.indexOf('see note', d.indexOf('beta'));
    const a = captureTextAnchor('thread-0001', 'a.md', d, second, second + 8);
    expect(resolveTextAnchor(`Header\n${d}`, a)).toMatchObject({ status: 'found', from: second + 7 });
  });

  it('reports ambiguity instead of guessing when context ties', () => {
    const d = 'x same x\n';
    const a = { ...captureTextAnchor('thread-0001', 'a.md', d, 2, 6), prefix: '', suffix: '' };
    const r = resolveTextAnchor('same and same', a);
    expect(r).toEqual({ status: 'ambiguous', candidates: [0, 9] });
  });

  it('reports ambiguity when the context no longer matches any copy', () => {
    const d = 'one fox here\n';
    const a = captureTextAnchor('thread-0001', 'a.md', d, 4, 7);
    expect(resolveTextAnchor('[fox] [fox]', a).status).toBe('ambiguous');
  });

  it('reports missing when the quoted text was deleted', () => {
    const [from, to] = at(doc, 'brown fox');
    const a = captureTextAnchor('thread-0001', 'a.md', doc, from, to);
    expect(resolveTextAnchor(doc.replace('brown fox', 'red cat'), a)).toEqual({ status: 'missing' });
    expect(resolveTextAnchor(doc, { ...a, quote: '' })).toEqual({ status: 'missing' });
  });

  describe('a short quote found only once', () => {
    const note = 'Intro line.\nTODO fix the parser before release.\n\nLater: TODO\n';
    const todo = () => captureTextAnchor('thread-0001', 'a.md', note, note.indexOf('TODO'), note.indexOf('TODO') + 4);

    it('is not moved to an unrelated copy when its own passage is deleted', () => {
      const after = 'Intro line.\n\nLater: TODO\n';
      expect(resolveTextAnchor(after, todo())).toEqual({ status: 'unconfirmed', at: after.indexOf('TODO') });
    });

    it('does not count a shared newline or space as context', () => {
      // The other copy also starts a line, so only the newline before it matches.
      const after = 'Intro line.\nSomething else:\nTODO later\n';
      expect(resolveTextAnchor(after, todo()).status).toBe('unconfirmed');
    });

    it('does not count a shared list marker or punctuation as context (Gitar on #40)', () => {
      const list = '# Plan\n- TODO fix the parser\n- write docs\n- TODO later\n';
      const a = captureTextAnchor('thread-0001', 'a.md', list, list.indexOf('TODO'), list.indexOf('TODO') + 4);
      expect(resolveTextAnchor(list.replace('- TODO fix the parser\n', ''), a).status).toBe('unconfirmed');
      const lines = 'Intro line.\nTODO fix the parser.\nSecond item.\nTODO later\n';
      const b = captureTextAnchor('thread-0001', 'a.md', lines, lines.indexOf('TODO'), lines.indexOf('TODO') + 4);
      expect(resolveTextAnchor(lines.replace('TODO fix the parser.\n', ''), b).status).toBe('unconfirmed');
    });

    it('does not count inline comment markup around another copy as context (Gitar on #40)', () => {
      const d = 'A {==TODO==}{>>alice|2026-09-16|note: first<<} here.\nB {==TODO==}{>>alice|2026-09-16|note: second<<} there.\n';
      const from = d.indexOf('TODO');
      const a = captureTextAnchor('thread-0001', 'a.md', d, from, from + 4);
      const after = d.slice(d.indexOf('\n') + 1);
      expect(resolveTextAnchor(after, a).status).toBe('unconfirmed');
    });

    it('needs only the word characters the saved context has, and checks markup only where it fits', () => {
      const d = '- TODO\n';
      const a = captureTextAnchor('thread-0001', 'a.md', d, 2, 6);
      expect(resolveTextAnchor('Intro\n- TODO\n', a)).toMatchObject({ status: 'found' });
      const start = captureTextAnchor('thread-0001', 'a.md', '{=TODO list', 2, 6);
      expect(resolveTextAnchor('{=TODO list', start)).toMatchObject({ status: 'found', from: 2 });
    });

    it('is found when some visible context survives on either side', () => {
      const edited = note.replace('Later: TODO', 'Later: done').replace('fix the parser', 'fix the lexer');
      expect(resolveTextAnchor(edited, todo())).toEqual({ status: 'found', from: note.indexOf('TODO'), to: note.indexOf('TODO') + 4 });
    });

    it('is found when no visible context was saved, as in a note holding only the quote', () => {
      const a = captureTextAnchor('thread-0001', 'a.md', 'TODO\n', 0, 4);
      expect(resolveTextAnchor('Some new text.\nTODO\n', a)).toMatchObject({ status: 'found' });
    });

    it('leaves a longer quote free to follow a moved paragraph', () => {
      const paragraph = 'This whole sentence is long enough to stand on its own.';
      const d = `First.\n\n${paragraph}\n\nLast.\n`;
      const a = captureTextAnchor('thread-0001', 'a.md', d, d.indexOf(paragraph), d.indexOf(paragraph) + paragraph.length);
      const moved = `Top!\n${paragraph}\nNew ending\n`;
      expect(resolveTextAnchor(moved, a)).toEqual({ status: 'found', from: 5, to: 5 + paragraph.length });
    });

    it('looks past inline comment markup that was later removed, even a comment cut off in the saved context', () => {
      const long = 'x'.repeat(80);
      const d = `Keep {==TODO==}{>>user|2026-09-16|note: ${long}<<} after.`;
      const from = d.indexOf('TODO');
      const a = captureTextAnchor('thread-0001', 'a.md', d, from, from + 4);
      expect(a.suffix.includes('<<}')).toBe(false);
      expect(resolveTextAnchor('Keep TODO after.', a)).toMatchObject({ status: 'found', from: 5 });
      expect(resolveTextAnchor('Other: TODO after.', a).status).toBe('unconfirmed');
    });

    it('never applies to image threads, whose embed is distinctive', () => {
      const d = 'See ![[a.png]] here.\n';
      const a = { ...captureTextAnchor('thread-0001', 'a.md', d, 4, 14), kind: 'image' as const, imagePath: 'a.png' };
      expect(resolveTextAnchor('Moved:\n![[a.png]]\n', a)).toMatchObject({ status: 'found', from: 7 });
    });
  });

  it('counts lines', () => {
    expect(lineOf('a\nb\nc', 4)).toBe(2);
    expect(lineOf('abc', 0)).toBe(0);
  });
});
