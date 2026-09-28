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

  it('counts lines', () => {
    expect(lineOf('a\nb\nc', 4)).toBe(2);
    expect(lineOf('abc', 0)).toBe(0);
  });
});
