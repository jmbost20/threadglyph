import { createServer, type Server } from 'http';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_SETTINGS,
  defaultAssistants,
  geminiFolderPath,
  migrateAiSettings,
  nodeGeminiFiles,
  preferredAssistant,
} from '../src/ai/assistants';
import type { ProcessRunner, RunOutcome } from '../src/ai/claudeCli';
import { findTool, toolPath } from '../src/ai/cliEnv';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_FOLDER_SETTINGS,
  GeminiCliAdapter,
  classifyGeminiFailure,
  NO_MCP_SERVERS,
  geminiArgs,
  geminiInput,
  geminiResponse,
  type GeminiFiles,
} from '../src/ai/geminiCli';
import { nodeHttp, type HttpCall, type HttpFn, type HttpOutcome } from '../src/ai/http';
import { OLLAMA_DEFAULT_CONTEXT, OllamaAdapter, contextTokens, isCloudModel, stripThinking } from '../src/ai/ollama';
import { SYSTEM_PROMPT } from '../src/ai/prompt';
import { AiSessions } from '../src/ai/session';
import type { AiAdapter, AiRequest } from '../src/ai/types';

const PNG = { path: 'Pics/sky.png', mediaType: 'image/png' as const, data: btoa('\x89PNG-bytes'), bytes: 9 };
const request = (over: Partial<AiRequest> = {}): AiRequest => ({
  noteName: 'Topic',
  quote: 'The passage',
  image: null,
  context: null,
  messages: [{ author: 'Me', origin: 'human', body: 'What does this mean?' }],
  ...over,
});
const live = () => new AbortController().signal;

describe('assistant settings', () => {
  it('prefers Local, then Gemini, then Claude, and builds only the enabled ones', () => {
    expect(defaultAssistants(DEFAULT_AI_SETTINGS)).toEqual([]);
    const all = defaultAssistants({ ...DEFAULT_AI_SETTINGS, aiEnabled: true });
    expect(all.map((a) => [a.id, a.name, a.egress])).toEqual([
      ['local', 'Local', 'local'],
      ['gemini', 'Gemini', 'cloud'],
      ['claude', 'Claude', 'cloud'],
    ]);
    expect(all.map((a) => a.detail)).toEqual(['qwen3:8b', DEFAULT_GEMINI_MODEL, 'Claude Code']);
    const some = defaultAssistants({ ...DEFAULT_AI_SETTINGS, aiEnabled: true, assistants: { local: false, gemini: true, claude: false } });
    expect(some.map((a) => a.id)).toEqual(['gemini']);
  });

  it('picks the preferred assistant when it is on, else the first one', () => {
    const all = defaultAssistants({ ...DEFAULT_AI_SETTINGS, aiEnabled: true });
    expect(preferredAssistant(all, 'gemini')?.id).toBe('gemini');
    expect(preferredAssistant(all.slice(1), 'local')?.id).toBe('gemini');
    expect(preferredAssistant([], 'local')).toBeNull();
  });

  it('migrates the single Claude model setting and repairs bad values', () => {
    const migrated = migrateAiSettings({ aiEnabled: true, aiModel: 'sonnet', defaultAssistant: 'nope', assistants: { claude: false } });
    expect(migrated).toMatchObject({ aiEnabled: true, claudeModel: 'sonnet', defaultAssistant: 'local', assistants: { local: true, gemini: true, claude: false } });
    expect('aiModel' in migrated).toBe(false);
    expect(migrateAiSettings({})).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('keeps Gemini in its own folder, never the vault', () => {
    // Node's own separators, so this reads \\Users\\me\\… on Windows.
    expect(geminiFolderPath({ geminiFolder: '' }, '/Users/me')).toBe(join('/Users/me', '.threadglyph', 'gemini'));
    expect(geminiFolderPath({ geminiFolder: '~/.ilc/gemini' }, '/Users/me')).toBe('/Users/me/.ilc/gemini');
    expect(geminiFolderPath({ geminiFolder: '/abs/dir' }, '/Users/me')).toBe('/abs/dir');
  });
});

describe('command-line tool environment', () => {
  it('finds tools in the usual install folders that Obsidian does not inherit', () => {
    expect(findTool('gemini', ' /custom/gemini ', '/Users/me', () => false)).toBe('/custom/gemini');
    expect(findTool('gemini', '', '/Users/me', (p) => p === '/opt/homebrew/bin/gemini')).toBe('/opt/homebrew/bin/gemini');
    expect(findTool('gemini', '', '/Users/me', () => false)).toBe('gemini');
  });

  it('puts the tool folder and install folders ahead of the inherited PATH, without repeats', () => {
    const path = toolPath('/Users/me/.npm-global/bin/gemini', '/usr/bin:/bin:/opt/homebrew/bin:', '/Users/me', ':').split(':');
    expect(path.slice(0, 3)).toEqual(['/Users/me/.npm-global/bin', '/opt/homebrew/bin', '/usr/local/bin']);
    expect(path.filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
    expect(path).toContain('/usr/bin');
    expect(path).not.toContain('');
    expect(toolPath('gemini', '', '/h', ':').split(':')[0]).toBe('/h/.npm-global/bin');
  });

  it('keeps Windows PATH entries whole: they are separated by ";" and contain "C:"', () => {
    const path = toolPath('C:\\Users\\me\\npm\\gemini.cmd', 'C:\\Windows;C:\\Program Files\\nodejs;', 'C:\\Users\\me', ';').split(';');
    expect(path[0]).toBe('C:\\Users\\me\\npm');
    expect(path).toContain('C:\\Windows');
    expect(path).toContain('C:\\Program Files\\nodejs');
    expect(path).not.toContain('C');
  });
});

describe('HTTP client', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/slow') return; // never answers
        res.writeHead(req.url === '/missing' ? 404 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('posts a body and returns status and text', async () => {
    const out = await nodeHttp({ url: `${base}/echo`, method: 'POST', body: '{"a":1}', timeoutMs: 5000, signal: live() });
    expect(out).toEqual({ ok: true, status: 200, text: JSON.stringify({ method: 'POST', body: '{"a":1}' }) });
    expect(await nodeHttp({ url: `${base}/missing`, timeoutMs: 5000, signal: live() })).toMatchObject({ ok: true, status: 404 });
  });

  it('reports timeouts, cancellation and refused connections without throwing', async () => {
    expect(await nodeHttp({ url: `${base}/slow`, timeoutMs: 100, signal: live() })).toMatchObject({ ok: false, reason: 'timeout' });
    const controller = new AbortController();
    const pending = nodeHttp({ url: `${base}/slow`, timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await nodeHttp({ url: `${base}/echo`, timeoutMs: 5000, signal: aborted.signal })).toMatchObject({ reason: 'aborted' });
    const refused = await nodeHttp({ url: 'http://127.0.0.1:1/x', timeoutMs: 5000, signal: live() });
    expect(refused).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('Local (Ollama) adapter', () => {
  function ollama(responses: Record<string, HttpOutcome>, model = 'qwen3:8b') {
    const http = vi.fn<HttpFn>(async (call: HttpCall) => responses[call.url.replace('http://localhost:11434', '')] ?? { ok: false, reason: 'network', message: 'ECONNREFUSED' });
    return { http, adapter: new OllamaAdapter({ host: 'http://localhost:11434/', model, timeoutMs: 60_000, http }) };
  }
  const chat = (content: string): HttpOutcome => ({ ok: true, status: 200, text: JSON.stringify({ message: { content } }) });

  it('sends the system prompt and fenced request to /api/chat without thinking, and returns the reply', async () => {
    const { http, adapter } = ollama({ '/api/chat': chat('<think>hmm</think> A short answer. ') });
    expect(await adapter.ask(request(), live())).toEqual({ ok: true, text: 'A short answer.' });
    const call = http.mock.calls[0][0];
    const body = JSON.parse(call.body!);
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, think: false });
    expect(body.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(body.messages[1].content).toContain('<note-excerpt>\nThe passage\n</note-excerpt>');
    expect(body.messages[1].images).toBeUndefined();
    expect(adapter).toMatchObject({ id: 'local', name: 'Local', detail: 'qwen3:8b', egress: 'local' });
  });

  it('uses the configured timeout and Ollama\'s own context window', async () => {
    const { http, adapter } = ollama({ '/api/chat': chat('ok') });
    await adapter.ask(request(), live());
    const call = http.mock.calls[0][0];
    expect(call.timeoutMs).toBe(60_000);
    expect(JSON.parse(call.body!).options).toBeUndefined();
  });

  it('widens the context window for a long note, so the instructions are not cut off', async () => {
    const { http, adapter } = ollama({ '/api/chat': chat('ok') });
    const text = 'A long paragraph of synthetic note text. '.repeat(900);
    await adapter.ask(request({ context: { label: 'The whole note', text } }), live());
    const body = JSON.parse(http.mock.calls[0][0].body!);
    expect(body.options.num_ctx % OLLAMA_DEFAULT_CONTEXT).toBe(0);
    expect(body.options.num_ctx).toBeGreaterThan(OLLAMA_DEFAULT_CONTEXT);
    expect(body.messages[0].content).toBe(SYSTEM_PROMPT);
    expect(contextTokens(9_000)).toBeNull();
    expect(contextTokens(9_300)).toBe(8_192);
    expect(contextTokens(500_000)).toBe(32_768);
  });

  it('refuses images for a model that cannot see, before sending anything', async () => {
    const { http, adapter } = ollama({ '/api/show': { ok: true, status: 200, text: JSON.stringify({ capabilities: ['completion'] }) } });
    const result = await adapter.ask(request({ image: PNG, quote: null }), live());
    expect(result).toMatchObject({ ok: false, kind: 'unsupported' });
    expect(result.ok || result.message).toMatch(/qwen3:8b cannot see images.*ollama pull qwen2.5vl:7b/);
    expect(http.mock.calls.map((c) => c[0].url)).toEqual(['http://localhost:11434/api/show']);
  });

  it('sends image bytes to a vision model, and when Ollama cannot say whether it sees', async () => {
    for (const show of [
      { ok: true as const, status: 200, text: JSON.stringify({ capabilities: ['completion', 'vision'] }) },
      { ok: true as const, status: 200, text: 'not json' },
      { ok: true as const, status: 404, text: '' },
    ]) {
      const { http, adapter } = ollama({ '/api/show': show, '/api/chat': chat('A gradient.') }, 'qwen2.5vl:7b');
      expect(await adapter.ask(request({ image: PNG }), live())).toEqual({ ok: true, text: 'A gradient.' });
      expect(JSON.parse(http.mock.calls[1][0].body!).messages[1].images).toEqual([PNG.data]);
    }
  });

  it('explains every failure in words the owner can act on', async () => {
    const ask = async (responses: Record<string, HttpOutcome>, model = 'qwen3:8b') => ollama(responses, model).adapter.ask(request(), live());
    expect(await ask({})).toMatchObject({ kind: 'network', message: expect.stringContaining('Start the Ollama app') });
    expect(await ask({ '/api/chat': { ok: false, reason: 'timeout', message: '' } })).toMatchObject({ kind: 'timeout', message: expect.stringContaining('60 seconds') });
    expect(await ask({ '/api/chat': { ok: false, reason: 'aborted', message: '' } })).toMatchObject({ kind: 'cancelled' });
    expect(await ask({ '/api/chat': { ok: true, status: 404, text: '{"error":"model not found"}' } })).toMatchObject({ kind: 'not-installed', message: expect.stringContaining('ollama pull qwen3:8b') });
    expect(await ask({ '/api/chat': { ok: true, status: 500, text: '{"error":"out of memory"}' } })).toMatchObject({ kind: 'failed', message: expect.stringContaining('out of memory') });
    expect(await ask({ '/api/chat': { ok: true, status: 200, text: '<html>' } })).toMatchObject({ kind: 'failed', message: expect.stringContaining('unreadable') });
    expect(await ask({ '/api/chat': chat('<think>only thinking</think>') })).toMatchObject({ kind: 'failed', message: expect.stringContaining('empty reply') });
    expect(await ask({}, ' ')).toMatchObject({ kind: 'not-installed' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await ollama({}).adapter.ask(request(), aborted.signal)).toMatchObject({ kind: 'cancelled' });
  });

  it('labels an Ollama server on another machine as leaving the computer (Codex review)', () => {
    const at = (host: string, model = 'qwen3:8b') => new OllamaAdapter({ host, model, timeoutMs: 1, http: vi.fn() });
    for (const host of ['http://localhost:11434', 'http://127.0.0.1:11434/', 'http://[::1]:11434', 'http://127.0.0.2:11434', ' ']) {
      expect(at(host)).toMatchObject({ egress: 'local' });
      expect(at(host).recipient).toBeUndefined();
    }
    expect(at('https://remote.example.invalid:11434')).toMatchObject({ egress: 'cloud', recipient: 'remote.example.invalid' });
    expect(at('http://192.168.1.20:11434')).toMatchObject({ egress: 'cloud', recipient: '192.168.1.20' });
    expect(at('not a url')).toMatchObject({ egress: 'cloud', recipient: 'not a url' });
    // No scheme: Node reads "gpu-box:" as the protocol. It is named as typed, never "ollama.com" (Gitar on #24).
    expect(at('gpu-box:11434')).toMatchObject({ egress: 'cloud', recipient: 'gpu-box:11434' });
    expect(at('localhost:11434')).toMatchObject({ egress: 'cloud', recipient: 'localhost:11434' });
    expect(at('http://localhost:11434', 'kimi-k3:cloud')).toMatchObject({ egress: 'cloud', recipient: 'ollama.com' });
  });

  it('labels Ollama cloud models as leaving the computer', () => {
    expect(isCloudModel('kimi-k3:cloud')).toBe(true);
    expect(isCloudModel('qwen3:8b')).toBe(false);
    expect(ollama({}, 'kimi-k3:cloud').adapter.egress).toBe('cloud');
    expect(stripThinking('<THINK>x</THINK>ok')).toBe('ok');
    expect(new OllamaAdapter({ host: ' ', model: 'm', timeoutMs: 1, http: vi.fn() })).toBeDefined();
  });
});

describe('Gemini CLI adapter', () => {
  const outcome = (over: Partial<RunOutcome>): RunOutcome => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...over });
  const reply = (text: string) => JSON.stringify({ session_id: 's', response: text, stats: {} }, null, 2);

  function gemini(out: RunOutcome, model = '') {
    const files: GeminiFiles = {
      prepareFolder: vi.fn(async () => {}),
      stageImage: vi.fn(async () => ({ dir: '/tmp/tg-x', file: '/tmp/tg-x/image.png' })),
      removeDir: vi.fn(async () => {}),
    };
    const run = vi.fn<ProcessRunner>(async () => out);
    const adapter = new GeminiCliAdapter({ command: '/bin/gemini', folder: '/home/.threadglyph/gemini', ownsFolder: true, model, timeoutMs: 90_000, env: { PATH: '/x' }, run, files });
    return { adapter, run, files };
  }

  it('runs read-only with extensions and MCP servers off, the request on stdin, in its own folder', async () => {
    const { adapter, run, files } = gemini(outcome({ stdout: `Warning\n${reply(' Hello. ')}` }));
    expect(await adapter.ask(request(), live())).toEqual({ ok: true, text: 'Hello.' });
    const [command, args, input, options] = run.mock.calls[0];
    expect(command).toBe('/bin/gemini');
    expect(args).toEqual([
      '-p', 'Write your reply now.', '--allowed-mcp-server-names', NO_MCP_SERVERS, '-e', 'none',
      '--output-format', 'json', '--approval-mode', 'plan', '-m', DEFAULT_GEMINI_MODEL,
    ]);
    // Gemini CLI treats an empty allow-list as "allow all", so it must name something.
    expect(NO_MCP_SERVERS).not.toBe('');
    expect(input).toBe(geminiInput(request()));
    expect(input.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(options).toMatchObject({ cwd: '/home/.threadglyph/gemini', timeoutMs: 90_000, env: { PATH: '/x' } });
    expect(files.prepareFolder).toHaveBeenCalledWith('/home/.threadglyph/gemini', expect.stringContaining('"selectedType": "gemini-api-key"'));
    expect(files.stageImage).not.toHaveBeenCalled();
    expect(adapter).toMatchObject({ id: 'gemini', name: 'Gemini', egress: 'cloud', detail: DEFAULT_GEMINI_MODEL });
  });

  it('switches off every built-in tool and usage statistics in its folder', () => {
    expect(GEMINI_FOLDER_SETTINGS.tools.exclude).toEqual(expect.arrayContaining(['read_file', 'run_shell_command', 'web_fetch', 'write_file']));
    expect(GEMINI_FOLDER_SETTINGS.privacy.usageStatisticsEnabled).toBe(false);
  });

  it('attaches an image from a private temporary folder and always deletes it', async () => {
    for (const out of [outcome({ stdout: reply('A gradient.') }), outcome({ code: 1, stderr: 'boom' })]) {
      const { adapter, run, files } = gemini(out, 'gemini-3.1-flash-lite');
      await adapter.ask(request({ image: PNG, quote: null }), live());
      const bytes = (files.stageImage as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array;
      expect([...bytes]).toEqual([...'\x89PNG-bytes'].map((c) => c.charCodeAt(0)));
      expect(files.stageImage).toHaveBeenCalledWith(expect.any(Uint8Array), 'png');
      expect(run.mock.calls[0][1].slice(0, 4)).toEqual(['-p', 'Attached image: @/tmp/tg-x/image.png', '--include-directories', '/tmp/tg-x']);
      expect(run.mock.calls[0][1].at(-1)).toBe('gemini-3.1-flash-lite');
      expect(files.removeDir).toHaveBeenCalledWith('/tmp/tg-x');
    }
  });

  it('reads the reply only from a successful JSON answer', () => {
    expect(geminiResponse(reply('x'))).toBe('x');
    expect(geminiResponse('no json')).toBeNull();
    expect(geminiResponse('{broken')).toBeNull();
    expect(geminiResponse(JSON.stringify({ response: '  ' }))).toBeNull();
    expect(geminiArgs('', null, null)).toContain(DEFAULT_GEMINI_MODEL);
  });

  it('turns CLI failures into specific, actionable errors', async () => {
    const ask = async (out: Partial<RunOutcome>) => gemini(outcome(out)).adapter.ask(request(), live());
    expect(await ask({ aborted: true, code: null })).toMatchObject({ kind: 'cancelled' });
    expect(await ask({ code: null, error: { code: 'ENOENT', message: 'spawn ENOENT' } })).toMatchObject({ kind: 'not-installed', message: expect.stringContaining('npm install -g @google/gemini-cli') });
    expect(await ask({ stdout: '' })).toMatchObject({ kind: 'failed', message: 'Gemini returned an empty reply.' });
    expect(await ask({ code: null, timedOut: true, stderr: 'Attempt 1 failed with status 503. Retrying with backoff...' })).toMatchObject({ kind: 'busy', message: expect.stringContaining('still retrying') });
    expect(await ask({ code: 1, stderr: '{"error":{"message":"You exceeded your quota","code":429}}' })).toMatchObject({ kind: 'quota' });
    expect(await ask({ code: null, timedOut: true, stderr: '' })).toMatchObject({ kind: 'timeout', message: expect.stringContaining('90 seconds') });
    expect(await ask({ code: 41, stderr: '{"session_id":"s","error":{"type":"FatalAuthenticationError","message":"No auth type is configured","code":41}}' })).toMatchObject({ kind: 'auth', message: expect.stringContaining('/home/.threadglyph/gemini/.gemini/.env') });
    expect(await ask({ code: 1, stderr: 'IneligibleTierError: UNSUPPORTED_CLIENT' })).toMatchObject({ kind: 'auth', message: expect.stringContaining('no longer serves') });
    expect(await ask({ code: 1, stderr: "SyntaxError: The requested module does not provide an export named 'x'" })).toMatchObject({ message: expect.stringContaining('Node 20') });
    expect(await ask({ code: 1, stderr: 'TypeError: fetch failed ENOTFOUND' })).toMatchObject({ kind: 'network' });
    expect(await ask({ code: 1, stderr: 'Something odd\n    at frame (file.js:1:1)' })).toMatchObject({ kind: 'failed', message: 'Gemini CLI failed: Something odd' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await gemini(outcome({})).adapter.ask(request(), aborted.signal)).toMatchObject({ kind: 'cancelled' });
  });

  it('classifies without a message too', () => {
    expect(classifyGeminiFailure('', '/f', false, 1000)).toEqual({ kind: 'failed', message: 'Gemini CLI failed: no details' });
  });
});

describe('Gemini folder files', () => {
  it('creates settings once, never overwrites them, and stages images privately', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tg-gemini-test-'));
    try {
      const run = vi.fn<ProcessRunner>(async () => ({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: { code: 'ENOENT', message: 'spawn ENOENT' } }));
      const adapter = new GeminiCliAdapter({ command: '/nonexistent/gemini', folder: home, ownsFolder: true, model: '', timeoutMs: 1000, env: {}, run, files: nodeGeminiFiles });
      const result = await adapter.ask(request({ image: PNG }), live());
      expect(result).toMatchObject({ ok: false, kind: 'not-installed' });
      const settingsPath = join(home, '.gemini', 'settings.json');
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(GEMINI_FOLDER_SETTINGS);
      await writeFile(settingsPath, '{"mine":true}');
      await adapter.ask(request(), live());
      expect(await readFile(settingsPath, 'utf8')).toBe('{"mine":true}');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

});

describe('sessions across assistants', () => {
  const adapter = (id: string): AiAdapter => ({
    id,
    name: id.toUpperCase(),
    detail: 'm',
    egress: 'local',
    capabilities: { text: true, images: true },
    ask: vi.fn(async () => ({ ok: true as const, text: `from ${id}` })),
  });
  const built = async () => ({ ok: true as const, request: request() });

  it('switches assistant in preview or after an error, starting a fresh request', async () => {
    const sessions = new AiSessions(() => {});
    const local = adapter('local');
    const gem = adapter('gemini');
    const find = (id: string) => ({ local, gemini: gem })[id] ?? null;
    sessions.open('t', 'local');
    sessions.open('t', 'gemini');
    expect(sessions.get('t')).toMatchObject({ phase: 'preview', assistant: 'gemini' });
    sessions.setAssistant('t', 'local');
    (local.ask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, kind: 'network', message: 'down' });
    await sessions.send('t', find, built);
    expect(sessions.get('t')).toMatchObject({ phase: 'error', assistant: 'local', attempts: 1 });
    sessions.setAssistant('t', 'gemini');
    expect(sessions.get('t')).toMatchObject({ phase: 'preview', assistant: 'gemini', attempts: 0 });
    await sessions.send('t', find, built);
    expect(sessions.get('t')).toMatchObject({ phase: 'draft', assistant: 'gemini', text: 'from gemini' });
    sessions.open('t', 'local');
    sessions.setAssistant('t', 'local');
    expect(sessions.get('t')).toMatchObject({ phase: 'draft', assistant: 'gemini' });
    sessions.setAssistant('missing', 'local');
  });

  it('reports an assistant that was switched off after the preview opened', async () => {
    const sessions = new AiSessions(() => {});
    sessions.open('t', 'claude');
    await sessions.send('t', () => null, built);
    expect(sessions.get('t')).toMatchObject({ phase: 'error', message: 'That assistant is switched off. Choose another one.' });
  });
});
