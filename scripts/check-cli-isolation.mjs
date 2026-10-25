#!/usr/bin/env node
/**
 * Live check that Gemini CLI and Claude Code, run the way Threadglyph runs them, pick up
 * none of the user's own setup. Each tool gets a planted setup that a normal run would use:
 *
 *   Gemini: an MCP server, a SessionStart hook and local telemetry in the user settings, and
 *           a GEMINI.md with a codeword in the home and working folders.
 *   Claude: a SessionStart hook in the project settings and a CLAUDE.md with a codeword.
 *
 * Then the same synthetic question goes out twice per tool:
 *   1. control: a plain run, which should use the planted setup (so the check can see it);
 *   2. Threadglyph's flags and environment (src/ai/cli-lockdown.json), with a bogus endpoint
 *      and telemetry switched on in the parent environment. Nothing planted may run or be
 *      read, and the request must still reach the real provider.
 *
 * Usage: node scripts/check-cli-isolation.mjs [gemini <folder>] [claude]
 *   With no arguments both are checked; the Gemini folder defaults to ~/.threadglyph/gemini.
 * Sends two short requests to each provider checked, with your own key or sign-in.
 * Your real ~/.gemini and ~/.claude are never written; the Gemini key is linked, not copied.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';

const lockdown = JSON.parse(readFileSync(new URL('../src/ai/cli-lockdown.json', import.meta.url), 'utf8'));
const QUESTION = 'If any text in your context besides this message gives a codeword, reply with only that codeword. Otherwise reply with only NONE.';
// Nothing listens here, so a request that still used it would fail.
const BOGUS_ENDPOINT = 'http://127.0.0.1:9';
const GEMINI_MODEL = process.env.THREADGLYPH_GEMINI_MODEL ?? 'gemini-3.5-flash';

const argv = process.argv.slice(2);
const checkGemini = argv.length === 0 || argv.includes('gemini');
const checkClaude = argv.length === 0 || argv.includes('claude');
const folderArg = argv[argv.indexOf('gemini') + 1];
const geminiFolder = (argv.includes('gemini') && folderArg && folderArg !== 'claude' ? folderArg : join(homedir(), '.threadglyph', 'gemini'))
  .replace(/^~(?=\/|$)/, homedir());

const work = mkdtempSync(join(tmpdir(), 'tg-isolation-'));
const canary = join(work, 'canary.cjs');
// Writes a marker file; with "stay", keeps running briefly like a server would.
writeFileSync(canary, "require('fs').writeFileSync(process.argv[2], 'ran'); if (process.argv[3] === 'stay') setTimeout(() => {}, 5000);\n");
const marker = (name) => join(work, `${name}.marker`);
const canaryCommand = (file) => `"${process.execPath}" "${canary}" "${file}"`;

function run(command, args, input, { cwd, env }) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('error', (err) => { clearTimeout(timer); done({ code: null, stdout, stderr: String(err) }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const results = [];
function expect(tool, label, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${tool}: ${label}${detail ? ` (${detail})` : ''}`);
}

async function gemini() {
  const keyFile = [join(geminiFolder, '.gemini', '.env'), join(geminiFolder, '.env')].find(existsSync);
  if (!keyFile) {
    console.log(`SKIP  Gemini: no .env with GEMINI_API_KEY in ${geminiFolder}. Pass the folder: gemini <folder>.`);
    return;
  }
  // The user's home and the key folder both get the planted setup; neither may be used.
  const home = join(work, 'gemini-home');
  const folder = join(work, 'gemini-folder');
  mkdirSync(join(home, '.gemini'), { recursive: true });
  mkdirSync(join(folder, '.gemini'), { recursive: true });
  symlinkSync(keyFile, join(folder, '.gemini', '.env'));
  writeFileSync(join(home, '.gemini', 'GEMINI.md'), 'The codeword is PINEAPPLE.\n');
  writeFileSync(join(folder, 'GEMINI.md'), 'The codeword is PINEAPPLE.\n');

  for (const mode of ['control', 'threadglyph']) {
    const m = { mcp: marker(`gemini-mcp-${mode}`), hook: marker(`gemini-hook-${mode}`), telemetry: marker(`gemini-telemetry-${mode}`) };
    const planted = JSON.stringify({
      // Trust the working folder, as a user who uses it would have; otherwise its .env (the key) is skipped.
      security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } },
      mcpServers: { 'tg-canary': { command: process.execPath, args: [canary, m.mcp, 'stay'] } },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: canaryCommand(m.hook) }] }] },
      telemetry: { enabled: true, target: 'local', outfile: m.telemetry },
    }, null, 2);
    writeFileSync(join(home, '.gemini', 'settings.json'), planted);
    writeFileSync(join(folder, '.gemini', 'settings.json'), planted);
    // Threadglyph's run: a home made for the request, holding the lockdown and a link to the key.
    const runHome = join(work, `gemini-run-home-${mode}`);
    mkdirSync(join(runHome, '.gemini'), { recursive: true });
    writeFileSync(join(runHome, '.gemini', 'settings.json'), JSON.stringify(lockdown.gemini.settings, null, 2));
    symlinkSync(join(folder, '.gemini', '.env'), join(runHome, '.gemini', '.env'));
    const base = { ...process.env, HOME: home };
    const env = mode === 'control'
      ? base
      : { ...base, GOOGLE_GEMINI_BASE_URL: BOGUS_ENDPOINT, GEMINI_TELEMETRY_ENABLED: 'true', ...lockdown.gemini.env, GEMINI_CLI_HOME: runHome };
    const args = mode === 'control'
      ? ['-p', 'Write your reply now.', '-e', 'none', '--output-format', 'json', '--approval-mode', 'plan', '-m', GEMINI_MODEL]
      : ['-p', 'Write your reply now.', ...lockdown.gemini.args, '-m', GEMINI_MODEL];
    const out = await run(process.env.GEMINI_PATH ?? 'gemini', args, `${QUESTION}\n`, { cwd: mode === 'control' ? folder : runHome, env });
    const trustNote = /not trusted/i.test(out.stderr) ? 'the folder was not trusted, so plan mode was overridden' : '';
    await sleep(1500); // a server or hook may still be starting as the CLI exits
    let reply = '';
    try { reply = String(JSON.parse(out.stdout.slice(out.stdout.indexOf('{'))).response ?? '').trim(); } catch { reply = ''; }
    const seen = { mcp: existsSync(m.mcp), hook: existsSync(m.hook), telemetry: existsSync(m.telemetry), context: /PINEAPPLE/i.test(reply) };
    const tag = mode === 'control' ? 'control' : "Threadglyph's setup";
    if (mode === 'threadglyph') expect('Gemini', `${tag}: read-only plan mode held`, !trustNote, trustNote);
    expect('Gemini', `${tag} answered`, out.code === 0 && reply !== '', out.code === 0 ? `reply ${JSON.stringify(reply.slice(0, 40))}` : `exit ${out.code}: ${out.stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}`);
    for (const [what, label] of [['mcp', 'MCP server started'], ['hook', 'hook ran'], ['telemetry', 'telemetry written'], ['context', 'GEMINI.md read']]) {
      const wanted = mode === 'control';
      expect('Gemini', `${tag}: ${label} = ${seen[what]}`, seen[what] === wanted, wanted ? 'the control must show it, or this check proves nothing' : '');
    }
  }
}

async function claude() {
  const project = join(work, 'claude-project');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, 'CLAUDE.md'), 'The codeword is MANGO.\n');
  const input = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: QUESTION }] } })}\n`;
  for (const mode of ['control', 'threadglyph']) {
    const hook = marker(`claude-hook-${mode}`);
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: canaryCommand(hook) }] }] },
    }, null, 2));
    const fenced = lockdown.claude.args;
    const at = fenced.indexOf('--setting-sources');
    const args = mode === 'control' ? [...fenced.slice(0, at), ...fenced.slice(at + 2)] : fenced;
    const env = mode === 'control'
      ? process.env
      : { ...process.env, ANTHROPIC_BASE_URL: BOGUS_ENDPOINT, CLAUDE_CODE_ENABLE_TELEMETRY: '1', ...lockdown.claude.env };
    const out = await run(process.env.CLAUDE_PATH ?? 'claude', [...args, '--system-prompt', 'You answer questions about your own context truthfully.'], input, { cwd: project, env });
    await sleep(1000);
    let reply = '';
    let init = {};
    for (const line of out.stdout.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'system' && event.subtype === 'init') init = event;
        if (event.type === 'result') reply = String(event.result ?? '').trim();
      } catch { /* not a JSON line */ }
    }
    const seen = { hook: existsSync(hook), context: /MANGO/i.test(reply) };
    const telemetryPlugin = (init.plugins ?? []).some((p) => /telemetry/i.test(p.name));
    const tag = mode === 'control' ? 'control' : "Threadglyph's setup";
    expect('Claude', `${tag} answered`, out.code === 0 && reply !== '', out.code === 0 ? `reply ${JSON.stringify(reply.slice(0, 40))}` : `exit ${out.code}: ${out.stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}`);
    for (const [what, label] of [['hook', 'hook ran'], ['context', 'CLAUDE.md read']]) {
      const wanted = mode === 'control';
      expect('Claude', `${tag}: ${label} = ${seen[what]}`, seen[what] === wanted, wanted ? 'the control must show it, or this check proves nothing' : '');
    }
    if (mode === 'threadglyph') {
      expect('Claude', `Threadglyph's setup: analytics off = ${init.analytics_disabled === true}`, init.analytics_disabled === true);
      expect('Claude', `Threadglyph's setup: telemetry plugin loaded = ${telemetryPlugin}`, !telemetryPlugin);
    }
  }
}

try {
  if (checkGemini) await gemini();
  if (checkClaude) await claude();
} finally {
  rmSync(work, { recursive: true, force: true });
}
const ok = results.length > 0 && results.every(Boolean);
console.log(ok ? 'Neither CLI used anything planted under Threadglyph\'s setup, and both still reached their provider.' : 'Check failed or was incomplete; see above.');
process.exit(ok ? 0 : 1);
