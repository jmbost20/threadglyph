import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inside, realPath, retireNote } from '../scripts/sandbox-lib.mjs';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-sandbox-test-')));
  const vault = join(root, 'sandbox');
  const outside = join(root, 'real vault');
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  mkdirSync(outside);
  return { vault, outside };
}

describe.skipIf(process.platform === 'win32')('sandbox write guard', () => {
  it('allows ordinary paths inside the sandbox, existing or not', () => {
    const { vault } = setup();
    expect(inside(vault, 'Notes/new.md')).toBe(join(vault, 'Notes', 'new.md'));
    expect(inside(vault, 'New folder/deeper/x.md')).toBe(join(vault, 'New folder', 'deeper', 'x.md'));
    expect(() => inside(vault, '../real vault/x.md')).toThrow(/outside the sandbox/);
  });

  it('refuses a linked folder that leads out', () => {
    const { vault, outside } = setup();
    symlinkSync(outside, join(vault, 'Linked'));
    expect(() => inside(vault, 'Linked/x.md')).toThrow(/outside the sandbox/);
  });

  it('refuses a dangling link whose target is outside, before anything is written (Gitar on #24)', () => {
    const { vault, outside } = setup();
    const target = join(outside, 'not yet.md');
    symlinkSync(target, join(vault, 'Notes', 'x.md'));
    expect(realPath(join(vault, 'Notes', 'x.md'))).toBe(target);
    expect(() => inside(vault, 'Notes/x.md')).toThrow(/outside the sandbox/);
    // A dangling link that stays inside is fine.
    symlinkSync(join(vault, 'Notes', 'later.md'), join(vault, 'Notes', 'y.md'));
    expect(inside(vault, 'Notes/y.md')).toBe(join(vault, 'Notes', 'y.md'));
    writeFileSync(join(vault, 'Notes', 'later.md'), 'ok');
  });
});

describe('retiring a renamed sample note (Gitar on #29 and #53)', () => {
  const OLD = 'Samples/Agent Comments sample.md';
  const NEW = 'Samples/Inline comments sample.md';
  function sandboxWithThreadOnOld() {
    const { vault } = setup();
    mkdirSync(join(vault, 'Samples'));
    mkdirSync(join(vault, 'threadglyph', 'threads'), { recursive: true });
    mkdirSync(join(vault, '.threadglyph', 'anchors'), { recursive: true });
    writeFileSync(join(vault, OLD), 'old copy');
    writeFileSync(join(vault, 'threadglyph', 'threads', 't1.json'), JSON.stringify({ id: 't1', notePath: OLD, revision: 1 }));
    writeFileSync(join(vault, '.threadglyph', 'anchors', 't1.json'), JSON.stringify({ threadId: 't1', notePath: OLD }));
    writeFileSync(join(vault, 'threadglyph', 'threads', 't2.json'), JSON.stringify({ id: 't2', notePath: 'Other.md', revision: 1 }));
    return vault;
  }
  const read = (vault: string, rel: string) => JSON.parse(readFileSync(join(vault, rel), 'utf8'));

  it('renames the old note when the new one is not there yet', () => {
    const vault = sandboxWithThreadOnOld();
    expect(retireNote(vault, OLD, NEW)).toBe(true);
    expect(existsSync(join(vault, OLD))).toBe(false);
    expect(readFileSync(join(vault, NEW), 'utf8')).toBe('old copy');
    expect(read(vault, 'threadglyph/threads/t1.json')).toMatchObject({ notePath: NEW, revision: 2 });
  });

  it('when both exist, moves the threads to the new note, keeps its text, and removes the old copy', () => {
    const vault = sandboxWithThreadOnOld();
    writeFileSync(join(vault, NEW), 'new copy');
    expect(retireNote(vault, OLD, NEW)).toBe(true);
    expect(existsSync(join(vault, OLD))).toBe(false);
    expect(readFileSync(join(vault, NEW), 'utf8')).toBe('new copy');
    expect(read(vault, 'threadglyph/threads/t1.json')).toMatchObject({ notePath: NEW, revision: 2 });
    expect(read(vault, '.threadglyph/anchors/t1.json')).toMatchObject({ notePath: NEW });
    expect(read(vault, 'threadglyph/threads/t2.json')).toMatchObject({ notePath: 'Other.md', revision: 1 });
  });

  it('deletes instead of moving a thread the new note already has, so imports do not double (Gitar on #53)', () => {
    const vault = sandboxWithThreadOnOld();
    writeFileSync(join(vault, NEW), 'new copy');
    const thread = (id: string, notePath: string, body: string) => {
      writeFileSync(join(vault, 'threadglyph', 'threads', `${id}.json`), JSON.stringify({ id, notePath, revision: 1, messages: [{ body }] }));
      writeFileSync(join(vault, '.threadglyph', 'anchors', `${id}.json`), JSON.stringify({ threadId: id, notePath, quote: 'plant the tomatoes early' }));
    };
    thread('imported-old', OLD, 'Is April too soon here?');
    thread('imported-new', NEW, 'Is April too soon here?');
    thread('own-old', OLD, 'A comment only the old note had');
    expect(retireNote(vault, OLD, NEW)).toBe(true);
    expect(existsSync(join(vault, 'threadglyph', 'threads', 'imported-old.json'))).toBe(false);
    expect(existsSync(join(vault, '.threadglyph', 'anchors', 'imported-old.json'))).toBe(false);
    expect(read(vault, 'threadglyph/threads/imported-new.json')).toMatchObject({ notePath: NEW, revision: 1 });
    expect(read(vault, 'threadglyph/threads/own-old.json')).toMatchObject({ notePath: NEW, revision: 2 });
    expect(read(vault, '.threadglyph/anchors/own-old.json')).toMatchObject({ notePath: NEW });
    expect(read(vault, 'threadglyph/threads/t1.json')).toMatchObject({ notePath: NEW, revision: 2 });
  });

  it('does nothing when there is no old note', () => {
    const vault = sandboxWithThreadOnOld();
    rmSync(join(vault, OLD));
    writeFileSync(join(vault, NEW), 'new copy');
    expect(retireNote(vault, OLD, NEW)).toBe(false);
    expect(read(vault, 'threadglyph/threads/t1.json')).toMatchObject({ notePath: OLD, revision: 1 });
  });
});
