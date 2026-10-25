import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS, defaultAssistants } from '../src/ai/assistants';
import type { ProcessRunner } from '../src/ai/claudeCli';
import { GeminiCliAdapter, type GeminiFiles } from '../src/ai/geminiCli';
import { AiSessions } from '../src/ai/session';
import type { AiAdapter } from '../src/ai/types';
import { ThreadController } from '../src/controller';
import { parseLegacyComments } from '../src/import/inlineComments';
import { buildExport } from '../src/storage/backup';
import { anchorPath } from '../src/storage/paths';
import { ThreadStore } from '../src/storage/threadStore';
import { MemoryFs, fakeClock, human } from './helpers';

// Regression tests for Gitar's review of PR #7.
describe('Gitar review on PR #7', () => {
  it('does not merge a plain highlight into the next commented one', () => {
    const doc = '{==a==} text {==b==}{>>user|2026-09-16|note: c<<} and {==unclosed';
    expect(parseLegacyComments(doc).map((t) => [t.quote, doc.slice(t.from, t.to)])).toEqual([['b', 'b']]);
    expect(parseLegacyComments('{==x==}{>>unterminated')).toEqual([]);
  });

  it('restore never overwrites an anchor file that already exists', async () => {
    const fs = new MemoryFs();
    const store = new ThreadStore(fs, fakeClock());
    const ctl = new ThreadController(store, () => human, fakeClock());
    ctl.beginThread('n.md', 'Some passage here.', 5, 12);
    await ctl.commitThread('Keep');
    const [thread] = store.snapshot().threads;
    const backup = JSON.parse(buildExport(store.snapshot().threads, store.snapshot().anchors, new Date()));
    // The thread file is gone, but a newer anchor (a later reattach) is still on disk.
    fs.files.delete(`threadglyph/threads/${thread.id}.json`);
    const newer = { ...backup.anchors[0], quote: 'passage here', prefix: 'Some ' };
    fs.files.set(anchorPath(thread.id), JSON.stringify(newer));
    const reloaded = new ThreadStore(fs, fakeClock());
    await reloaded.loadAll();
    expect(await reloaded.restore(backup.threads[0], backup.anchors[0])).toBe('restored');
    expect(JSON.parse(fs.files.get(anchorPath(thread.id))!).quote).toBe('passage here');
    expect(reloaded.anchorFor(thread.id)?.quote).toBe('passage here');
  });

  it('never writes into a Gemini folder it borrows', async () => {
    const files: GeminiFiles = { prepareFolder: vi.fn(async () => {}), stageImage: vi.fn(), removeDir: vi.fn() };
    const run = vi.fn<ProcessRunner>(async () => ({ code: 0, stdout: '{"response":"ok"}', stderr: '', timedOut: false, aborted: false }));
    const request = { noteName: 'n', quote: 'q', image: null, context: null, messages: [] };
    const base = { command: 'g', folder: '/f', model: '', timeoutMs: 1000, env: {}, run, files };
    await new GeminiCliAdapter({ ...base, ownsFolder: false }).ask(request, new AbortController().signal);
    expect(files.prepareFolder).not.toHaveBeenCalled();
    await new GeminiCliAdapter({ ...base, ownsFolder: true }).ask(request, new AbortController().signal);
    expect(files.prepareFolder).toHaveBeenCalledTimes(1);
    const [, borrowed] = defaultAssistants({ ...DEFAULT_AI_SETTINGS, aiEnabled: true, geminiFolder: '~/.ilc/gemini' });
    const [, own] = defaultAssistants({ ...DEFAULT_AI_SETTINGS, aiEnabled: true });
    expect((borrowed as unknown as { options: { ownsFolder: boolean } }).options.ownsFolder).toBe(false);
    expect((own as unknown as { options: { ownsFolder: boolean } }).options.ownsFolder).toBe(true);
  });

  it('an @mention after a failed request switches to that assistant', async () => {
    const sessions = new AiSessions(() => {});
    const failing: AiAdapter = {
      id: 'local', name: 'Local', detail: 'm', egress: 'local', capabilities: { text: true, images: true },
      ask: async () => ({ ok: false, kind: 'network', message: 'down' }),
    };
    sessions.open('t', 'local');
    await sessions.send('t', () => failing, async () => ({ ok: true, request: { noteName: 'n', quote: 'q', image: null, context: null, messages: [] } }));
    sessions.open('t', 'local');
    expect(sessions.get('t')).toMatchObject({ phase: 'error', assistant: 'local', attempts: 1 });
    sessions.open('t', 'gemini');
    expect(sessions.get('t')).toMatchObject({ phase: 'preview', assistant: 'gemini', attempts: 0 });
  });
});
