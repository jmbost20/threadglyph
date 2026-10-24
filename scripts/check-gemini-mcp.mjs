#!/usr/bin/env node
/**
 * Live check that Threadglyph's Gemini CLI flags start none of the user's MCP servers.
 *
 * It makes a throwaway home folder whose user-level Gemini settings declare one MCP server,
 * a "canary" that writes a marker file the moment Gemini starts it. Then it sends the same
 * synthetic request ("Reply with the single word: ok") twice from your Gemini folder, where
 * your API key's .env lives:
 *   1. control: without the allow-list flag. The canary should start (so the check can see it);
 *   2. Threadglyph's flags (src/ai/geminiCli.ts). The canary must not start.
 * Your real ~/.gemini is never read or written, apart from copying trustedFolders.json.
 *
 * Usage: node scripts/check-gemini-mcp.mjs [gemini folder]   (default ~/.threadglyph/gemini)
 * Sends two short requests to Google with your Gemini API key.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { join } from 'node:path';

// Keep in step with geminiArgs() and NO_MCP_SERVERS in src/ai/geminiCli.ts (tests pin those).
const NO_MCP_SERVERS = 'threadglyph-no-mcp-servers';
const MODEL = process.env.THREADGLYPH_GEMINI_MODEL ?? 'gemini-3.5-flash';
const base = ['-p', 'Write your reply now.'];
const tail = ['-e', 'none', '--output-format', 'json', '--approval-mode', 'plan', '-m', MODEL];
const RUNS = [
  { name: 'control (no allow-list)', args: [...base, ...tail], expectCanary: true },
  { name: "Threadglyph's flags", args: [...base, '--allowed-mcp-server-names', NO_MCP_SERVERS, ...tail], expectCanary: false },
];

const folder = (process.argv[2] ?? process.env.THREADGLYPH_GEMINI_FOLDER ?? join(homedir(), '.threadglyph', 'gemini')).replace(/^~(?=\/|$)/, homedir());
const gemini = process.env.GEMINI_PATH ?? 'gemini';
if (!existsSync(folder)) {
  console.error(`No Gemini folder at ${folder}. Pass the folder Threadglyph uses (Settings → Gemini folder).`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'tg-mcp-check-'));
const home = join(work, 'home');
mkdirSync(join(home, '.gemini'), { recursive: true });
const trusted = join(homedir(), '.gemini', 'trustedFolders.json');
if (existsSync(trusted)) copyFileSync(trusted, join(home, '.gemini', 'trustedFolders.json'));

function run({ args }, marker) {
  const canary = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => {}, 5000);`;
  writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'gemini-api-key' } },
    mcpServers: { 'tg-canary': { command: process.execPath, args: ['-e', canary] } },
  }, null, 2));
  return new Promise((done) => {
    const child = spawn(gemini, args, { cwd: folder, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (err) => { clearTimeout(timer); done({ code: null, stdout, stderr: String(err) }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.stdin.end('Reply with the single word: ok\n');
  });
}

const reply = (stdout) => {
  try { return String(JSON.parse(stdout.slice(stdout.indexOf('{'))).response ?? '').trim().slice(0, 80); } catch { return '(no JSON reply)'; }
};

let ok = true;
try {
  for (const [i, r] of RUNS.entries()) {
    const marker = join(work, `canary-${i}.txt`);
    const out = await run(r, marker);
    // The canary may still be starting as Gemini exits; give it a moment.
    await sleep(1500);
    const started = existsSync(marker);
    const pass = started === r.expectCanary && out.code === 0;
    ok &&= pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${r.name}: canary ${started ? 'STARTED' : 'not started'} (expected ${r.expectCanary ? 'started' : 'not started'}); exit ${out.code}; reply ${JSON.stringify(reply(out.stdout))}`);
    if (out.code !== 0) console.log(`      stderr: ${out.stderr.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? 'Gemini started no MCP server under Threadglyph\'s flags.' : 'Check failed; see above.');
process.exit(ok ? 0 : 1);
